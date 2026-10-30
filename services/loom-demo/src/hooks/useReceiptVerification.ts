import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { resolveReceiptKey, type ResolvedReceiptKey } from '../api/keys';
import { cachedIssuerKeys, discoverIssuerKeys, type KeyDiscoveryState } from '../api/keyDiscovery';
import { diagnoseReceiptInput, type ReceiptInputProblem } from '../api/receiptInput';
import {
  isBoundResult,
  verificationContextId,
  verificationRequestKey,
} from '../api/verificationContext';
import type { VerificationPhase } from '../api/trustPresentation';
import {
  getKdCoreWasmStatus,
  initKdCoreWasm,
  subscribeKdCoreWasm,
  verifyReceiptWasm,
  verifyReceiptWasmWithKeySet,
  type WasmVerifyReport,
} from '../api/wasmEngine';

/**
 * Where the text in the verifier editor came from. Only 'sample' (a bundled,
 * labelled fixture) may resolve the public demo key; every other origin is
 * fail-closed to the issuer key set or an explicit manual key.
 */
export type ArtifactOrigin = 'sample' | 'user' | 'file' | 'handoff';

export interface ReceiptArtifact {
  text: string;
  origin: ArtifactOrigin;
  /** What the editor holds, in words (e.g. "Bundled drand sample"), or null. */
  label: string | null;
}

export interface BoundVerification {
  report: WasmVerifyReport;
  resolved: ResolvedReceiptKey;
  inputProblem: ReceiptInputProblem | null;
  engineFailed: boolean;
}

interface StoredResult extends BoundVerification {
  contextId: string;
}

/**
 * The report as the page may present it. With no trust root (no published key
 * matched and no manual key) the signature was never checked against a key, so
 * its row is "not run", not a cryptographic failure. The replay checks did run.
 */
export function presentableReport(bound: BoundVerification | null): WasmVerifyReport | null {
  if (!bound) return null;
  if (bound.resolved.source === 'unresolved' && bound.report.verdict !== 'ERROR') {
    return { ...bound.report, valid_signature: undefined };
  }
  return bound.report;
}

export interface UseReceiptVerificationOptions {
  initial: ReceiptArtifact;
  verifyInitial: boolean;
  /** Behind a Roll treats an in-place edit of the sample as its tamper action, so
   * the edited sample keeps the labelled demo-key context. Verify does not. */
  editsKeepSampleOrigin: boolean;
}

function engineSnapshot() {
  return getKdCoreWasmStatus();
}

/**
 * Shared verifier-page state. Inputs (receipt text, origin, manual key) are owned
 * here and never written by async work. Every verdict is stored with the exact
 * context it was computed for, and exposed only while that context is current.
 */
export function useReceiptVerification(options: UseReceiptVerificationOptions) {
  const { editsKeepSampleOrigin } = options;
  const [artifact, setArtifact] = useState<ReceiptArtifact>(options.initial);
  const [manualKey, setManualKeyState] = useState<string | null>(null);
  const [requested, setRequested] = useState<string | null>(() =>
    options.verifyInitial
      ? verificationRequestKey({
          text: options.initial.text,
          allowDemoFallback: options.initial.origin === 'sample',
          manualKey: null,
        })
      : null,
  );
  const [result, setResult] = useState<StoredResult | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<KeyDiscoveryState>(() => {
    const cached = cachedIssuerKeys();
    return cached ? { status: 'ready', ...cached } : { status: 'loading' };
  });
  const [discoveryAttempt, setDiscoveryAttempt] = useState(0);
  const engine = useSyncExternalStore(subscribeKdCoreWasm, engineSnapshot, engineSnapshot);
  // Bumped by every user change to the verification context (receipt text, sample,
  // upload, manual key); an async file read only lands if nothing else changed
  // that context while it was in flight.
  const inputGeneration = useRef(0);
  const pendingFile = useRef<string | null>(null);

  /** A user action replaced the context: cancel any file read still in flight. */
  const supersede = useCallback(() => {
    inputGeneration.current += 1;
    if (pendingFile.current !== null) {
      setFileNotice(
        `Stopped loading ${pendingFile.current}: the receipt or key changed while it was being read. Choose the file again to load it.`,
      );
      pendingFile.current = null;
    }
  }, []);

  useEffect(() => {
    initKdCoreWasm().catch(() => {
      /* reported through the engine status */
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    discoverIssuerKeys(controller.signal)
      .then(setDiscovery)
      .catch(() => {
        /* aborted by unmount or effect replay; the newer run owns the state */
      });
    return () => controller.abort();
  }, [discoveryAttempt]);

  const allowDemoFallback = artifact.origin === 'sample';
  const manual = manualKey !== null && manualKey.trim() !== '';
  const effectiveManualKey = manual ? manualKey : null;
  const requestKey = verificationRequestKey({
    text: artifact.text,
    allowDemoFallback,
    manualKey: effectiveManualKey,
  });
  const diagnosis = useMemo(() => diagnoseReceiptInput(artifact.text), [artifact.text]);
  const keys = useMemo(() => (discovery.status === 'ready' ? discovery.keys : []), [discovery]);
  const keysRevision = discovery.status === 'loading' ? null : discovery.revision;
  const resolved = useMemo(
    () => resolveReceiptKey(artifact.text, keys, effectiveManualKey, { allowDemoFallback }),
    [artifact.text, keys, effectiveManualKey, allowDemoFallback],
  );
  const contextId = verificationContextId({
    requestKey,
    inputOk: diagnosis.ok,
    manual,
    keysRevision,
    engine,
  });

  const waitingForKeys = !manual && discovery.status === 'loading';
  const waitingForEngine = engine === 'idle' || engine === 'loading';

  useEffect(() => {
    if (requested !== requestKey) return;
    if (result?.contextId === contextId) return;
    if (!diagnosis.ok) {
      setResult({
        contextId,
        report: { verdict: 'ERROR', error: diagnosis.message },
        resolved,
        inputProblem: diagnosis,
        engineFailed: false,
      });
      return;
    }
    if (waitingForKeys) return;
    if (engine === 'failed') {
      setResult({
        contextId,
        report: {
          verdict: 'ERROR',
          error: 'The verifier engine failed to load, so nothing was checked. Retry loading the engine.',
        },
        resolved,
        inputProblem: null,
        engineFailed: true,
      });
      return;
    }
    if (waitingForEngine) return;
    const report =
      resolved.kind === 'manual'
        ? verifyReceiptWasm(artifact.text, resolved.publicKey)
        : verifyReceiptWasmWithKeySet(artifact.text, resolved.keySetJson);
    setResult({ contextId, report, resolved, inputProblem: null, engineFailed: false });
  }, [
    requested,
    requestKey,
    result,
    contextId,
    diagnosis,
    waitingForKeys,
    waitingForEngine,
    engine,
    resolved,
    artifact.text,
  ]);

  const bound = isBoundResult(result, requested, requestKey, contextId) ? result : null;
  let phase: VerificationPhase;
  if (requested !== requestKey) phase = 'not_checked';
  else if (bound) phase = 'complete';
  else if (diagnosis.ok && (waitingForKeys || waitingForEngine)) phase = 'loading';
  else phase = 'verifying';

  const editText = useCallback(
    (text: string) => {
      setFileError(null);
      supersede();
      setArtifact((prev) => {
        if (editsKeepSampleOrigin && prev.origin === 'sample') {
          return { text, origin: 'sample', label: prev.label };
        }
        return { text, origin: 'user', label: prev.origin === 'user' ? prev.label : null };
      });
    },
    [editsKeepSampleOrigin, supersede],
  );

  /** Replace the editor contents. `keepManualKey` preserves a typed key (tamper
   * edits); loaders of a new artifact return to issuer key resolution. */
  const loadArtifact = useCallback(
    (next: ReceiptArtifact, opts: { verify: boolean; keepManualKey: boolean }) => {
      setFileError(null);
      setFileNotice(null);
      supersede();
      setArtifact(next);
      const nextManual = opts.keepManualKey ? manualKey : null;
      if (!opts.keepManualKey) setManualKeyState(null);
      setRequested(
        opts.verify
          ? verificationRequestKey({
              text: next.text,
              allowDemoFallback: next.origin === 'sample',
              manualKey: nextManual !== null && nextManual.trim() !== '' ? nextManual : null,
            })
          : null,
      );
    },
    [manualKey, supersede],
  );

  const loadFile = useCallback(
    async (file: File) => {
      const generation = ++inputGeneration.current;
      pendingFile.current = file.name;
      setFileNotice(null);
      let text: string;
      try {
        text = await file.text();
      } catch {
        if (generation === inputGeneration.current) {
          pendingFile.current = null;
          setFileError(`Could not read ${file.name}. Nothing was verified.`);
        }
        return;
      }
      // A newer edit, sample, upload or key change superseded this read while it
      // was in flight; the later user context wins.
      if (generation !== inputGeneration.current) return;
      pendingFile.current = null;
      loadArtifact({ text, origin: 'file', label: file.name }, { verify: true, keepManualKey: false });
    },
    [loadArtifact],
  );

  const setManualKey = useCallback(
    (value: string) => {
      supersede();
      setManualKeyState(value);
    },
    [supersede],
  );

  const clearManualKey = useCallback(() => {
    supersede();
    setManualKeyState(null);
  }, [supersede]);

  const verify = useCallback(() => {
    setRequested(requestKey);
  }, [requestKey]);

  const retryEngine = useCallback(() => {
    initKdCoreWasm().catch(() => {
      /* reported through the engine status */
    });
  }, []);

  const retryKeyDiscovery = useCallback(() => {
    setDiscovery({ status: 'loading' });
    setDiscoveryAttempt((n) => n + 1);
  }, []);

  return {
    artifact,
    manualKey,
    manual,
    resolved,
    diagnosis,
    discovery,
    engine,
    phase,
    bound: bound as BoundVerification | null,
    fileError,
    fileNotice,
    editText,
    loadArtifact,
    loadFile,
    setManualKey,
    clearManualKey,
    verify,
    retryEngine,
    retryKeyDiscovery,
  };
}

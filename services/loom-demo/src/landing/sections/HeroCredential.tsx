import { useCallback, useEffect, useRef, useState } from 'react';
import type { useKarmaState } from '../../hooks/useKarmaState';
import type { HeroPhase } from '../three/HeroCanvas';
import type { Die, ReceiptVerifyResponse } from '../../types/kd';
import { buildReceiptBody, hasDrandProof as receiptHasDrandProof, tamperedView } from '../../api/receipt';
import { postVerifyReceipt } from '../../api/client';
import { FACES } from '../../constants/caps';
import { InkFrame } from '../system/InkFrame';
import { InkButton } from '../system/InkButton';
import css from './HeroCredential.module.css';

const ROW_LABELS: ReadonlyArray<[keyof Pick<ReceiptVerifyResponse, 'valid_signature' | 'valid_drand' | 'valid_sampling' | 'face_ok' | 'metrics_ok'>, string]> = [
  ['valid_signature', 'Signature'],
  ['valid_drand', 'Drand proof'],
  ['valid_sampling', 'Seed replay'],
  ['face_ok', 'Face recompute'],
  ['metrics_ok', 'Metrics'],
];

interface Props {
  state: ReturnType<typeof useKarmaState>;
  onPhase: (p: HeroPhase) => void;
}

export function HeroCredential({ state, onPhase }: Props) {
  const entry = state.rolls.length > 0 ? state.rolls[0] : null;
  const [verify, setVerify] = useState<ReceiptVerifyResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const lastId = useRef<number | null>(null);

  // The break lives on the entry itself, so a tamper here OR in the playground reads
  // the same forged body + failing result, and it persists across re-rolls/reloads.
  const tamperState = entry?.tampered ?? null;
  const tamper = tamperState?.result ?? null;

  const signed = !!entry?.sig && !state.mock;
  const hasDrandProof = entry ? receiptHasDrandProof(entry) : false;

  // New roll → reset, signal 'settled', then auto-verify the clean receipt.
  useEffect(() => {
    if (!entry) {
      onPhase('idle');
      return;
    }
    if (entry.localId === lastId.current) return;
    lastId.current = entry.localId;
    setVerify(null);
    onPhase('settled');
    if (state.mock || !entry.sig) return;

    let cancelled = false;
    postVerifyReceipt(buildReceiptBody(entry))
      .then((res) => {
        if (cancelled) return;
        setVerify(res);
        const allOk =
          res.valid_signature &&
          (!hasDrandProof || res.valid_drand !== false) &&
          res.valid_sampling &&
          res.face_ok &&
          res.metrics_ok;
        onPhase(allOk ? 'sealed' : 'settled');
      })
      .catch(() => {
        /* leave unverified; phase stays settled */
      });
    return () => {
      cancelled = true;
    };
  }, [entry, hasDrandProof, state.mock, onPhase]);

  const doTamper = useCallback(async () => {
    if (!entry?.sig) return;
    setBusy(true);
    try {
      const body = buildReceiptBody(entry) as Record<string, unknown>;
      const faces = FACES[entry.die as Die] ?? 20;
      body.face = (entry.face % faces) + 1; // flip one byte
      const res = await postVerifyReceipt(body);
      // Lift the break into shared state with the tampered body - the hero die, the
      // playground seed, the transcript row and the receipt modal all read it, so
      // the broken die is the SAME forged, failing artifact across the page.
      state.markTampered(entry.localId, body, res);
    } catch {
      /* network error - leave state */
    } finally {
      setBusy(false);
    }
  }, [entry, state]);

  if (!entry) {
    return (
      <InkFrame seed={64} className={`${css.card} ${css.empty}`} aria-hidden="true">
        <span className={css.emptyText}>Roll to mint a signed receipt</span>
      </InkFrame>
    );
  }

  const shown = tamper ?? verify;
  const tampered = !!tamper;
  // When broken, show the forged values the tampered receipt actually carries.
  const view = tamperState
    ? tamperedView(tamperState.body, { face: entry.face, kappa: entry.kappa, die: entry.die })
    : { face: entry.face, kappa: entry.kappa, die: entry.die };
  const kappaText = `${view.kappa >= 0 ? '+' : ''}${view.kappa.toFixed(2)}`;

  let pill: { label: string; tone: string };
  if (tampered) pill = { label: 'Tampered', tone: css.toneFail };
  else if (verify) pill = { label: 'Verified', tone: css.toneOk };
  else if (state.mock) pill = { label: 'Demo', tone: css.toneNeutral };
  else pill = { label: 'Signed', tone: css.toneNeutral };

  return (
    <InkFrame seed={65} className={`${css.card} ${tampered ? css.cardFail : ''}`}>
      <div className={css.head}>
        <span className={css.brand}>Receipt</span>
        <span className={`${css.pill} ${pill.tone}`}>{pill.label}</span>
      </div>

      <div className={css.result}>
        <span className={css.face}>{view.face}</span>
        <span className={css.meta}>{view.die} · κ {kappaText}</span>
      </div>

      <div className={css.checks}>
        {ROW_LABELS.filter(([key]) => key !== 'valid_drand' || hasDrandProof).map(([key, label]) => {
          const ok = shown ? shown[key] : null;
          const cls = ok == null ? css.pending : ok ? css.ok : css.fail;
          return (
            <div key={key} className={`${css.checkRow} ${cls}`}>
              <span className={css.pip} aria-hidden="true" />
              <span>{label}</span>
              <span className={css.srOnly}>{ok == null ? 'not run' : ok ? 'pass' : 'fail'}</span>
            </div>
          );
        })}
      </div>

      <InkButton
        inline={false}
        seed={66}
        frameClassName={css.tamperBtnWrap}
        className={css.tamperBtn}
        onClick={doTamper}
        disabled={!signed || busy || tampered}
        title={signed ? 'Flip one byte and re-verify' : 'Start the API for real signing'}
      >
        {busy ? 'Re-verifying…' : tampered ? 'Signature broke' : 'Tamper & re-verify'}
      </InkButton>
    </InkFrame>
  );
}

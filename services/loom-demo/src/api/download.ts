/** Save `text` as a .json file. Returns false when the browser blocks it. */
export function downloadJson(filename: string, text: string): boolean {
  try {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke after the click has been handled; revoking synchronously can cancel it.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

export function receiptFilename(rollId: string, suffix = ''): string {
  const safe = rollId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 36) || 'receipt';
  return `truerolls-${safe}${suffix}.json`;
}

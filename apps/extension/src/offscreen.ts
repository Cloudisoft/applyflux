/// <reference types="chrome" />
/** Offscreen page whose only job is to play the alert chime (service workers have no audio). */
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id || msg?.type !== 'offscreen:chime') return;
  const ctx = new AudioContext();
  // Two soft rising tones: noticeable without being alarming.
  [[660, 0], [880, 0.18]].forEach(([freq, at]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime + at);
    osc.stop(ctx.currentTime + at + 0.4);
  });
  setTimeout(() => void ctx.close(), 1000);
});

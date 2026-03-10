export class CrowdManager {
  constructor(options = {}) {
    this.count = options.initialCount ?? 10;
    this.uiCountEl = options.uiCountEl;
    this.uiOutcomeEl = options.uiOutcomeEl;
    this.updateUI('Ready');
  }

  increase(amount = 3) {
    this.count += amount;
    this.updateUI('Crowd grew');
  }

  decrease(amount = 2) {
    this.count = Math.max(0, this.count - amount);
    this.updateUI('Crowd shrank');
  }

  reset(initial = 10) {
    this.count = initial;
    this.updateUI('Reset');
  }

  updateUI(message) {
    if (this.uiCountEl) {
      this.uiCountEl.textContent = `Crowd: ${this.count}`;
    }
    if (this.uiOutcomeEl) {
      this.uiOutcomeEl.textContent = message;
    }
  }
}

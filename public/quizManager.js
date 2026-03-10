export class QuizManager {
  constructor(options = {}) {
    this.endpoint = options.endpoint || '/api/questions/latest';
    this.onStatus = options.onStatus || (() => {});
  }

  async loadQuestions() {
    try {
      this.onStatus('Requesting questions...');
      const res = await fetch(this.endpoint, { method: 'GET', headers: { Accept: 'application/json' } });
      if (!res.ok) {
        throw new Error(`API returned ${res.status}`);
      }
      const data = await res.json();
      const questions = Array.isArray(data?.questions) ? data.questions : [];
      if (!questions.length) {
        throw new Error('Empty questions payload');
      }
      const normalized = this.normalizeQuestions(questions);
      if (!normalized.length) {
        throw new Error('No valid questions after normalization');
      }
      this.onStatus('Questions loaded');
      return normalized;
    } catch (err) {
      console.warn('Falling back to local sample questions:', err);
      this.onStatus('Using fallback questions');
      return this.getFallbackQuestions();
    }
  }

  normalizeQuestions(rawList) {
    return rawList
      .filter((q) => q && q.question && Array.isArray(q.options) && typeof q.answerIndex === 'number')
      .map((q, idx) => {
        const opts = q.options.slice(0, 2);
        while (opts.length < 2) opts.push(opts.length === 0 ? 'A: placeholder' : 'B: placeholder');
        const labeled = opts.map((opt, i) => {
          const prefix = i === 0 ? 'A:' : 'B:';
          return opt?.trim().startsWith(prefix) ? opt : `${prefix} ${opt || ''}`.trim();
        });
        const answerIndex = q.answerIndex === 1 ? 1 : 0;
        return {
          id: q.id || `q-${idx + 1}`,
          question: q.question,
          options: labeled,
          answerIndex,
        };
      });
  }

  getFallbackQuestions() {
    return [
      {
        id: 'q-1',
        question: 'What does WebGL enable inside the browser?',
        options: ['A: Hardware-accelerated 3D', 'B: Email delivery'],
        answerIndex: 0,
      },
      {
        id: 'q-2',
        question: 'Which vector describes position in Babylon.js?',
        options: ['A: Vector3', 'B: Vector2'],
        answerIndex: 0,
      },
      {
        id: 'q-3',
        question: 'What is a common way to detect mesh collisions?',
        options: ['A: ActionManager triggers', 'B: CSS media queries'],
        answerIndex: 0,
      },
    ];
  }
}

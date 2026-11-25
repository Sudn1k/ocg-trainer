/**
 * Core quiz engine: search normalization, shuffling, session building, and grading.
 */

const HOMOGLYPH_MAP = {
  a: 'а', A: 'А',
  b: 'в', B: 'В',
  c: 'с', C: 'С',
  e: 'е', E: 'Е',
  h: 'н', H: 'Н',
  k: 'к', K: 'К',
  m: 'м', M: 'М',
  o: 'о', O: 'О',
  p: 'р', P: 'Р',
  t: 'т', T: 'Т',
  x: 'х', X: 'Х',
  y: 'у', Y: 'У',
  ё: 'е', Ё: 'Е',
};

export function normalizeForSearch(str) {
  return String(str || '')
    .replace(/[a-zA-ZёЁ]/g, (ch) => HOMOGLYPH_MAP[ch] || ch)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeTextAnswer(str) {
  return String(str || '')
    .replace(/\u00A0/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[ёЁ]/g, (c) => (c === 'ё' ? 'е' : 'Е'))
    .toLowerCase();
}

export function shuffleArray(arr, rng = Math.random) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function questionMatchesSearch(q, query) {
  const normQuery = normalizeForSearch(query);
  if (!normQuery) return true;
  if (normalizeForSearch(q.prompt).includes(normQuery)) return true;
  if (q.options && q.options.some((o) => normalizeForSearch(o.text).includes(normQuery))) return true;
  if (
    q.pairs &&
    q.pairs.some(
      (p) => normalizeForSearch(p.left).includes(normQuery) || normalizeForSearch(p.right).includes(normQuery)
    )
  ) {
    return true;
  }
  if (q.acceptedAnswers && q.acceptedAnswers.some((a) => normalizeForSearch(a).includes(normQuery))) {
    return true;
  }
  if (q.items && q.items.some((item) => normalizeForSearch(item).includes(normQuery))) {
    return true;
  }
  return false;
}

export function buildSessionQuestions(questions, config = {}) {
  const {
    count = questions.length,
    shuffleQuestions = true,
    shuffleOptions = true,
    rng = Math.random,
  } = config;

  const pool = shuffleQuestions ? shuffleArray(questions, rng) : [...questions];
  const limit = Math.max(1, Math.min(count, pool.length));
  const selected = pool.slice(0, limit);

  return selected.map((q) => {
    if (q.type === 'single' || q.type === 'multi') {
      const indexed = q.options.map((opt, origIndex) => ({ ...opt, origIndex }));
      const displayOptions = shuffleOptions ? shuffleArray(indexed, rng) : indexed;
      return {
        ...q,
        displayOptions,
      };
    }

    if (q.type === 'matching') {
      const displayRightOptions = shuffleOptions
        ? shuffleArray(q.rightOptions, rng)
        : [...q.rightOptions];
      return {
        ...q,
        displayRightOptions,
      };
    }

    if (q.type === 'sequence') {
      let displayItems = shuffleArray(q.items, rng);
      if (q.items.length > 1 && displayItems.every((v, idx) => v === q.items[idx])) {
        displayItems = [...q.items.slice(1), q.items[0]];
      }
      return {
        ...q,
        displayItems,
      };
    }

    return { ...q };
  });
}

export function hasUserAnswer(question, userAnswer) {
  if (question.type === 'single') {
    return typeof userAnswer === 'number' && userAnswer >= 0;
  }
  if (question.type === 'multi') {
    return Array.isArray(userAnswer) && userAnswer.length > 0;
  }
  if (question.type === 'matching') {
    return (
      Array.isArray(userAnswer) &&
      userAnswer.length === question.pairs.length &&
      userAnswer.every((v) => typeof v === 'string' && v.length > 0)
    );
  }
  if (question.type === 'text') {
    return typeof userAnswer === 'string' && userAnswer.trim().length > 0;
  }
  if (question.type === 'sequence') {
    return Array.isArray(userAnswer) && userAnswer.length === question.items.length;
  }
  return false;
}

export function gradeAnswer(question, userAnswer) {
  if (question.type === 'single') {
    const isCorrect =
      typeof userAnswer === 'number' && question.correctIndices.includes(userAnswer);
    return {
      isCorrect,
      correctIndices: question.correctIndices,
      selectedIndices: typeof userAnswer === 'number' ? [userAnswer] : [],
    };
  }

  if (question.type === 'multi') {
    const selected = Array.isArray(userAnswer)
      ? [...new Set(userAnswer)].sort((a, b) => a - b)
      : [];
    const expected = [...new Set(question.correctIndices)].sort((a, b) => a - b);
    const isCorrect =
      selected.length === expected.length &&
      selected.every((val, idx) => val === expected[idx]);
    const missedIndices = expected.filter((idx) => !selected.includes(idx));
    const extraIndices = selected.filter((idx) => !expected.includes(idx));
    return {
      isCorrect,
      correctIndices: expected,
      selectedIndices: selected,
      missedIndices,
      extraIndices,
    };
  }

  if (question.type === 'matching') {
    const chosen = Array.isArray(userAnswer) ? userAnswer : [];
    const rowResults = question.pairs.map((pair, idx) => chosen[idx] === pair.right);
    const isCorrect = rowResults.length > 0 && rowResults.every(Boolean);
    return {
      isCorrect,
      rowResults,
      chosen,
    };
  }

  if (question.type === 'text') {
    const normUser = normalizeTextAnswer(userAnswer);
    const isCorrect =
      normUser.length > 0 &&
      question.acceptedAnswers.some((ans) => normalizeTextAnswer(ans) === normUser);
    return {
      isCorrect,
      userText: String(userAnswer || '').trim(),
      acceptedAnswers: question.acceptedAnswers,
    };
  }

  if (question.type === 'sequence') {
    const chosen = Array.isArray(userAnswer) ? userAnswer : [];
    const rowResults = question.items.map((item, idx) => chosen[idx] === item);
    const isCorrect = rowResults.length > 0 && rowResults.every(Boolean);
    return {
      isCorrect,
      rowResults,
      chosen,
    };
  }

  return { isCorrect: false };
}

export function formatPromptHtmlForDisplay(question) {
  let html = question.promptHtml || `<p>${question.prompt}</p>`;
  // Replace Moodle cloze placeholder "Ответ Вопрос N{{sub}}" with a styled blank badge
  html = html.replace(
    /Ответ\s+Вопрос\s*\d+\s*\{\{sub\}\}/gi,
    '<span class="cloze-blank" title="Пропущенное слово">________</span>'
  );
  return html;
}

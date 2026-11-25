/**
 * Shared SyncShare HTML parser (works identically in Node.js with html-dom.mjs
 * and in the browser with native DOMParser).
 */

function qsa(el, selector) {
  return el ? Array.from(el.querySelectorAll(selector)) : [];
}

function cleanWhitespace(str) {
  return (str || '').replace(/\u00A0/g, ' ').trim();
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Normalizes inner HTML of a question prompt or option:
 * - Restores MathJax <mjx-container> spans that came from Moodle `$X$` Excel cell references
 *   (or preserves clean <math> fallback for genuine math expressions).
 * - Resolves <img> src paths via optional resolver.
 */
function normalizeRichHtml(node, resolveImageSrc) {
  if (!node) return '';
  let html = node.innerHTML || '';

  html = html.replace(/<mjx-container[\s\S]*?<\/mjx-container>/gi, (block) => {
    const mathMatch = block.match(/<math[^>]*>([\s\S]*?)<\/math>/i);
    if (!mathMatch) return block;
    const plainMath = mathMatch[1].replace(/<[^>]+>/g, '').trim();
    if (/^[A-Za-z0-9]{1,3}$/.test(plainMath)) {
      return `$${plainMath}$`;
    }
    return `<span class="math-expr">${escapeHtml(plainMath)}</span>`;
  });

  if (typeof resolveImageSrc === 'function') {
    html = html.replace(/(<img\b[^>]*\bsrc=")([^"]+)("[^>]*>)/gi, (_, pre, src, post) => {
      return `${pre}${escapeHtml(resolveImageSrc(src))}${post}`;
    });
  }

  return html.trim();
}

function extractPlainText(node) {
  if (!node) return '';
  const html = normalizeRichHtml(node);
  return cleanWhitespace(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
  );
}

function parseStats(card) {
  const headings = qsa(card, 'h3');
  const statsHeading = headings.find((h) => cleanWhitespace(h.textContent) === 'Статистика');
  if (!statsHeading) return null;
  const container = statsHeading.parentElement || statsHeading.parent;
  if (!container) return null;

  const table = container.querySelector('table');
  if (table) {
    const headers = qsa(table, 'thead th').map((th) => cleanWhitespace(th.textContent));
    const rows = qsa(table, 'tbody tr').map((tr) => {
      const cells = qsa(tr, 'td');
      if (headers.includes('За') && headers.includes('Против') && cells.length >= 3) {
        return {
          answer: extractPlainText(cells[0]),
          forVotes: parseInt(cleanWhitespace(cells[1].textContent), 10) || 0,
          againstVotes: parseInt(cleanWhitespace(cells[2].textContent), 10) || 0,
        };
      }
      return {
        answer: extractPlainText(cells[0]),
        count: cells[1] ? parseInt(cleanWhitespace(cells[1].textContent), 10) || 0 : 0,
        verdict: cells[2] ? cleanWhitespace(cells[2].textContent) : '',
      };
    });
    return {
      kind: headers.includes('За') ? 'votes' : 'choice',
      headers,
      rows,
    };
  }

  const groups = qsa(container, 'ul > li.border');
  if (groups.length > 0) {
    const items = groups.map((li) => {
      const titleEl = li.querySelector('div.font-semibold');
      const entries = qsa(li, 'ul > li').map((sub) => {
        const spans = qsa(sub, 'span');
        const label = spans[0] ? cleanWhitespace(spans[0].textContent) : cleanWhitespace(sub.textContent);
        const verdict = spans[1] ? cleanWhitespace(spans[1].textContent) : '';
        return { label, verdict };
      });
      return {
        left: titleEl ? cleanWhitespace(titleEl.textContent) : '',
        entries,
      };
    });
    return { kind: 'matching', items };
  }

  return null;
}

function findDirectPromptAndMedia(card, resolveImageSrc) {
  const body = card.querySelector('div.px-6.py-6');
  if (!body) return { promptText: '', promptHtml: '', images: [] };

  const promptDiv = body.querySelector('div.mb-6');
  const promptHtml = promptDiv ? normalizeRichHtml(promptDiv, resolveImageSrc) : '';
  const promptText = promptDiv ? extractPlainText(promptDiv) : '';

  const imgs = [];
  const seenSrc = new Set();
  for (const img of qsa(promptDiv, 'img')) {
    const src = img.getAttribute('src');
    if (src) {
      seenSrc.add(resolveImageSrc ? resolveImageSrc(src) : src);
    }
  }
  for (const img of qsa(body, 'img')) {
    const src = img.getAttribute('src');
    if (!src) continue;
    const resolved = resolveImageSrc ? resolveImageSrc(src) : src;
    if (!seenSrc.has(resolved)) {
      seenSrc.add(resolved);
      imgs.push(resolved);
    }
  }

  return { promptText, promptHtml, images: imgs };
}

function parseQuestionCard(card, index, topicId, resolveImageSrc) {
  const rawId = card.getAttribute('id') || `q_${topicId}_${index + 1}`;
  const h2 = card.querySelector('h2');
  const numMatch = h2 ? cleanWhitespace(h2.textContent).match(/(\d+)/) : null;
  const number = numMatch ? parseInt(numMatch[1], 10) : index + 1;

  const { promptText, promptHtml, images } = findDirectPromptAndMedia(card, resolveImageSrc);
  const stats = parseStats(card);

  const sourceEls = qsa(card, 'p.text-right');
  const sourceText = sourceEls.length > 0
    ? cleanWhitespace(sourceEls[sourceEls.length - 1].textContent).replace(/^Источник:\s*/i, '')
    : 'lms.guap.ru';

  const body = card.querySelector('div.px-6.py-6') || card;
  const radioInputs = qsa(body, 'input[type="radio"]');
  const checkboxInputs = qsa(body, 'input[type="checkbox"]');
  const headings = qsa(body, 'h3').map((h) => cleanWhitespace(h.textContent));
  const tables = qsa(body, 'table');
  const matchingTable = tables.find((t) => {
    const ths = qsa(t, 'thead th').map((th) => cleanWhitespace(th.textContent));
    return ths.includes('Левая часть') && ths.includes('Правая часть');
  });

  // 1. Single choice (radio)
  if (radioInputs.length > 0) {
    const options = radioInputs.map((inp) => {
      const p1 = inp.parentElement || inp.parent;
      const row = p1 ? (p1.parentElement || p1.parent) : null;
      const label = row ? row.querySelector('label') : null;
      return {
        text: extractPlainText(label),
        html: normalizeRichHtml(label, resolveImageSrc),
        checked: inp.hasAttribute('checked'),
      };
    });
    let correctIndices = options
      .map((o, idx) => (o.checked ? idx : -1))
      .filter((idx) => idx !== -1);

    let answerSource = 'checked';
    if (correctIndices.length === 0 && stats && stats.kind === 'choice') {
      const correctTexts = new Set(
        stats.rows.filter((r) => r.verdict === 'Правильно').map((r) => r.answer)
      );
      correctIndices = options
        .map((o, idx) => (correctTexts.has(o.text) ? idx : -1))
        .filter((idx) => idx !== -1);
      answerSource = 'stats';
    }

    return {
      id: `${topicId}_${rawId}`,
      sourceQuestionId: rawId,
      topicId,
      number,
      type: 'single',
      prompt: promptText,
      promptHtml,
      images,
      options: options.map(({ text, html }) => ({ text, html })),
      correctIndices,
      answerSource,
      stats,
      source: sourceText,
    };
  }

  // 2. Multiple choice (checkbox)
  if (checkboxInputs.length > 0) {
    const options = checkboxInputs.map((inp) => {
      const p1 = inp.parentElement || inp.parent;
      const row = p1 ? (p1.parentElement || p1.parent) : null;
      const label = row ? row.querySelector('label') : null;
      return {
        text: extractPlainText(label),
        html: normalizeRichHtml(label, resolveImageSrc),
        checked: inp.hasAttribute('checked'),
      };
    });

    let correctIndices = options
      .map((o, idx) => (o.checked ? idx : -1))
      .filter((idx) => idx !== -1);

    let answerSource = 'checked';
    if (correctIndices.length === 0 && stats && stats.kind === 'votes') {
      const majorityTexts = new Set(
        stats.rows.filter((r) => r.forVotes > r.againstVotes).map((r) => r.answer)
      );
      correctIndices = options
        .map((o, idx) => (majorityTexts.has(o.text) ? idx : -1))
        .filter((idx) => idx !== -1);
      answerSource = 'stats_votes';
    }

    return {
      id: `${topicId}_${rawId}`,
      sourceQuestionId: rawId,
      topicId,
      number,
      type: 'multi',
      prompt: promptText,
      promptHtml,
      images,
      options: options.map(({ text, html }) => ({ text, html })),
      correctIndices,
      answerSource,
      stats,
      source: sourceText,
    };
  }

  // 3. Matching (Левая часть / Правая часть)
  if (matchingTable) {
    const pairs = qsa(matchingTable, 'tbody tr').map((tr) => {
      const tds = qsa(tr, 'td');
      return {
        left: extractPlainText(tds[0]),
        leftHtml: normalizeRichHtml(tds[0], resolveImageSrc),
        right: extractPlainText(tds[1]),
        rightHtml: normalizeRichHtml(tds[1], resolveImageSrc),
      };
    });

    const rightHeading = qsa(body, 'h3').find(
      (h) => cleanWhitespace(h.textContent) === 'Варианты правой части'
    );
    let rightOptions = [];
    if (rightHeading) {
      const container = rightHeading.parentElement || rightHeading.parent;
      rightOptions = qsa(container, 'ul > li').map((li) => {
        const spans = qsa(li, 'span');
        const target = spans.length > 1 ? spans[spans.length - 1] : li;
        return extractPlainText(target);
      });
    }
    if (rightOptions.length === 0) {
      rightOptions = [...new Set(pairs.map((p) => p.right))];
    }

    return {
      id: `${topicId}_${rawId}`,
      sourceQuestionId: rawId,
      topicId,
      number,
      type: 'matching',
      prompt: promptText,
      promptHtml,
      images,
      pairs,
      rightOptions,
      answerSource: 'table',
      stats,
      source: sourceText,
    };
  }

  // 4. Sequence / ordering
  if (headings.includes('Правильная последовательность')) {
    const seqHeading = qsa(body, 'h3').find(
      (h) => cleanWhitespace(h.textContent) === 'Правильная последовательность'
    );
    const box = seqHeading.parentElement || seqHeading.parent;
    const items = qsa(box, 'li').map((li) => extractPlainText(li)).filter(Boolean);
    if (items.length > 0) {
      return {
        id: `${topicId}_${rawId}`,
        sourceQuestionId: rawId,
        topicId,
        number,
        type: 'sequence',
        prompt: promptText,
        promptHtml,
        images,
        items,
        answerSource: 'sequence_box',
        stats,
        source: sourceText,
      };
    }
  }

  // 5. Text / fill-in-the-blank (Правильный ответ)
  if (headings.includes('Правильный ответ')) {
    const correctHeading = qsa(body, 'h3').find(
      (h) => cleanWhitespace(h.textContent) === 'Правильный ответ'
    );
    const box = correctHeading.parentElement || correctHeading.parent;
    const olItems = qsa(box, 'ol > li').map((li) => extractPlainText(li)).filter(Boolean);
    if (olItems.length > 1) {
      return {
        id: `${topicId}_${rawId}`,
        sourceQuestionId: rawId,
        topicId,
        number,
        type: 'sequence',
        prompt: promptText,
        promptHtml,
        images,
        items: olItems,
        answerSource: 'correct_box_ol',
        stats,
        source: sourceText,
      };
    }

    const codes = qsa(box, 'code');
    let acceptedAnswers = [];
    if (codes.length > 0) {
      acceptedAnswers = codes.map((c) => cleanWhitespace(c.textContent)).filter(Boolean);
    } else {
      const mono = box.querySelector('p.font-mono') || box.querySelector('p');
      if (mono) acceptedAnswers = [cleanWhitespace(mono.textContent)].filter(Boolean);
    }

    return {
      id: `${topicId}_${rawId}`,
      sourceQuestionId: rawId,
      topicId,
      number,
      type: 'text',
      prompt: promptText,
      promptHtml,
      images,
      acceptedAnswers,
      answerSource: 'correct_box',
      stats,
      source: sourceText,
    };
  }

  return {
    id: `${topicId}_${rawId}`,
    sourceQuestionId: rawId,
    topicId,
    number,
    type: 'unknown',
    prompt: promptText,
    promptHtml,
    images,
    rawHtml: body.innerHTML,
    answerSource: 'unknown',
    stats,
    source: sourceText,
  };
}

function slugifyId(str) {
  return str
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'topic';
}

export function parseSyncShareDocument(doc, options = {}) {
  const { fileName = 'imported.html', resolveImageSrc = null } = options;

  const h1 = doc.querySelector('main h1');
  const h1Text = h1 ? cleanWhitespace(h1.textContent) : '';
  const mainSubtitle = doc.querySelector('main p.text-neutral-600');
  const subtitleText = mainSubtitle ? cleanWhitespace(mainSubtitle.textContent) : '';

  const fallbackTitle = fileName.replace(/\.html?$/i, '');
  const title = subtitleText && h1Text === 'Просмотр вопросов' ? subtitleText : (subtitleText || fallbackTitle);

  const sectionMatch = title.match(/разделу\s*(\d+)/i) || fileName.match(/разделу?\s*(\d+)/i);
  const sectionNumber = sectionMatch ? parseInt(sectionMatch[1], 10) : null;

  const mainEl = doc.querySelector('main') || doc;
  const mainText = mainEl ? mainEl.textContent : '';
  const statedMatch = mainText.match(/Вопросов в тесте:\s*(\d+)/i);
  const statedCount = statedMatch ? parseInt(statedMatch[1], 10) : null;

  const cards = qsa(mainEl, 'div[id^="q"]');
  const topicId = sectionNumber ? `section-${sectionNumber}` : slugifyId(fallbackTitle);

  const isQuizBankList = h1Text === 'Банк вопросов' && cards.length === 0;
  const availableQuizzes = isQuizBankList
    ? qsa(mainEl, 'h4').map((h4) => {
        const card = h4.parentElement || h4.parent;
        const idText = card ? card.textContent.match(/ID:\s*(\d+)/) : null;
        return {
          title: cleanWhitespace(h4.textContent),
          quizId: idText ? idText[1] : null,
        };
      })
    : [];

  const questions = cards.map((card, idx) =>
    parseQuestionCard(card, idx, topicId, resolveImageSrc)
  );

  return {
    topic: {
      id: topicId,
      title,
      shortTitle: title.replace(/^Тестирование по разделу\s*\d+\s*/i, '').replace(/^["«]|["»]$/g, '') || title,
      sectionNumber,
      sourceFile: fileName,
      statedCount,
      actualCount: questions.length,
      isQuizBankList,
      availableQuizzes,
    },
    questions,
  };
}

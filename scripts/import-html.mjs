import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseHtmlDom } from './html-dom.mjs';
import { parseSyncShareDocument } from '../src/js/syncshare-parser.js';
import { buildStandalone } from './build-standalone.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIRS = ['d:\\ОЦГ', path.join(ROOT, 'source-html')];
const DATA_DIR = path.join(ROOT, 'src', 'data');
const ASSETS_IMG_DIR = path.join(ROOT, 'assets', 'images');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(ROOT, 'source-html'), { recursive: true });

const cliDirs = process.argv.slice(2).filter((d) => fs.existsSync(d));
const dirsToScan = cliDirs.length > 0 ? cliDirs : SOURCE_DIRS;

const seenFiles = new Map();
for (const dir of dirsToScan) {
  if (!fs.existsSync(dir)) continue;
  for (const entry of fs.readdirSync(dir)) {
    if (entry.toLowerCase().endsWith('.html') || entry.toLowerCase().endsWith('.htm')) {
      // Later dir (e.g. source-html) overrides earlier if same filename
      seenFiles.set(entry, path.join(dir, entry));
    }
  }
}

const topics = [];
const allQuestions = [];
const warnings = [];
let copiedImages = 0;

for (const [fileName, fullPath] of [...seenFiles.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru'))) {
  const html = fs.readFileSync(fullPath, 'utf8');
  const dom = parseHtmlDom(html);
  const baseDir = path.dirname(fullPath);

  const resolveImageSrc = (src) => {
    if (!src || /^(https?:|data:|blob:)/i.test(src)) return src;
    const decodedRel = decodeURIComponent(src.replace(/^\.\//, ''));
    const absSrc = path.resolve(baseDir, decodedRel);
    if (!fs.existsSync(absSrc)) return src;
    fs.mkdirSync(ASSETS_IMG_DIR, { recursive: true });
    const safeName = `${fileName.replace(/\.html?$/i, '').replace(/[^a-zA-Z0-9_-]+/g, '_')}_${path.basename(absSrc)}`;
    const dest = path.join(ASSETS_IMG_DIR, safeName);
    fs.copyFileSync(absSrc, dest);
    copiedImages++;
    return `./assets/images/${safeName}`;
  };

  const { topic, questions } = parseSyncShareDocument(dom, { fileName, resolveImageSrc });

  if (topic.isQuizBankList) {
    warnings.push(
      `[ПРОПУЩЕН] ${fileName}: файл сохранён со страницы списка тестов («Банк вопросов»), а не со страницы вопросов («Просмотр вопросов»). Вопросов внутри: 0.`
    );
    continue;
  }

  if (questions.length === 0) {
    warnings.push(`[ПРОПУЩЕН] ${fileName}: не найдено ни одного вопроса.`);
    continue;
  }

  if (topic.statedCount !== null && topic.statedCount !== questions.length) {
    warnings.push(
      `[НЕСОВПАДЕНИЕ] ${fileName}: заявлено ${topic.statedCount}, извлечено ${questions.length}.`
    );
  }

  // Validate every question has a known type and answer
  for (const q of questions) {
    if (q.type === 'unknown') {
      warnings.push(`[НЕИЗВЕСТНЫЙ ТИП] ${fileName} :: ${q.sourceQuestionId} (Вопрос ${q.number})`);
    } else if ((q.type === 'single' || q.type === 'multi') && q.correctIndices.length === 0) {
      warnings.push(`[НЕТ ОТВЕТА] ${fileName} :: ${q.sourceQuestionId} (Вопрос ${q.number})`);
    } else if (q.type === 'matching' && q.pairs.length === 0) {
      warnings.push(`[НЕТ ПАР] ${fileName} :: ${q.sourceQuestionId} (Вопрос ${q.number})`);
    } else if (q.type === 'text' && q.acceptedAnswers.length === 0) {
      warnings.push(`[НЕТ ОТВЕТА] ${fileName} :: ${q.sourceQuestionId} (Вопрос ${q.number})`);
    }
  }

  topics.push(topic);
  allQuestions.push(...questions);
}

// Sort topics by sectionNumber if present, then by title
topics.sort((a, b) => {
  if (a.sectionNumber !== null && b.sectionNumber !== null) {
    return a.sectionNumber - b.sectionNumber;
  }
  if (a.sectionNumber !== null) return -1;
  if (b.sectionNumber !== null) return 1;
  return a.title.localeCompare(b.title, 'ru');
});

const dataset = {
  generatedAt: new Date().toISOString(),
  totalTopics: topics.length,
  totalQuestions: allQuestions.length,
  topics,
  questions: allQuestions,
  warnings,
};

fs.writeFileSync(path.join(DATA_DIR, 'questions.json'), JSON.stringify(dataset, null, 2), 'utf8');
fs.writeFileSync(
  path.join(DATA_DIR, 'questions.js'),
  `export const INITIAL_DATASET = ${JSON.stringify(dataset, null, 2)};\n`,
  'utf8'
);

console.log(`Импорт завершён: тем = ${topics.length}, вопросов = ${allQuestions.length}, изображений скопировано = ${copiedImages}`);
for (const t of topics) {
  console.log(`  • ${t.title}: ${t.actualCount} вопр. (заявлено: ${t.statedCount ?? '—'})`);
}
if (warnings.length > 0) {
  console.log('\nПредупреждения:');
  for (const w of warnings) console.log('  ' + w);
}

buildStandalone();


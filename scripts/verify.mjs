import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { Writable } from 'stream';
import { fileURLToPath } from 'url';
import { parseHtmlDom } from './html-dom.mjs';
import { parseSyncShareDocument } from '../src/js/syncshare-parser.js';
import { createRequestHandler, handleRequest } from '../server.mjs';
import {
  buildSessionQuestions,
  gradeAnswer,
  hasUserAnswer,
  questionMatchesSearch,
} from '../src/js/quiz-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`✓ ${name}`);
}

const dataset = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'questions.json'), 'utf8'));

test('Извлечены все 378 вопросов из 7 разделов без потерь', () => {
  assert.strictEqual(dataset.totalTopics, 7);
  assert.strictEqual(dataset.totalQuestions, 378);
  assert.strictEqual(dataset.topics.length, 7);
  assert.strictEqual(dataset.questions.length, 378);
  for (const t of dataset.topics) {
    assert.strictEqual(t.actualCount, t.statedCount, `Несовпадение в теме ${t.title}`);
  }
});

test('У каждого вопроса определён тип и есть правильный ответ', () => {
  for (const q of dataset.questions) {
    assert.notStrictEqual(q.type, 'unknown', `Неизвестный тип у ${q.id}`);
    if (q.type === 'single' || q.type === 'multi') {
      assert.ok(q.options.length >= 2, `Мало вариантов у ${q.id}`);
      assert.ok(q.correctIndices.length >= 1, `Нет правильных ответов у ${q.id}`);
    } else if (q.type === 'matching') {
      assert.ok(q.pairs.length >= 2, `Мало пар у ${q.id}`);
      assert.ok(q.rightOptions.length >= 2, `Нет правой части у ${q.id}`);
    } else if (q.type === 'text') {
      assert.ok(q.acceptedAnswers.length >= 1, `Нет правильного текста у ${q.id}`);
    }
  }
});

test('Корректно восстановлены формулы Excel с $ из MathJax (q438639, q438637)', () => {
  const q1 = dataset.questions.find((q) => q.sourceQuestionId === 'q438639');
  assert.strictEqual(q1.options[0].text, 'F45/$H$12');
  const q2 = dataset.questions.find((q) => q.sourceQuestionId === 'q438637');
  assert.ok(q2.prompt.includes('$A$6:C13'));
});

test('Вопросы без checked="" корректно определены по За/Против (q438450, q438913, q438921)', () => {
  const q450 = dataset.questions.find((q) => q.sourceQuestionId === 'q438450');
  assert.deepStrictEqual(q450.correctIndices, [2, 3, 4, 5, 7]);
  assert.strictEqual(q450.answerSource, 'stats_votes');

  const q913 = dataset.questions.find((q) => q.sourceQuestionId === 'q438913');
  assert.deepStrictEqual(q913.correctIndices, [1, 3]);

  const q921 = dataset.questions.find((q) => q.sourceQuestionId === 'q438921');
  assert.deepStrictEqual(q921.correctIndices, [0, 1, 2]);
});

test('Вопросы с 2 правильными радио-ответами принимают любой из них (q438643, q438486)', () => {
  const q643 = dataset.questions.find((q) => q.sourceQuestionId === 'q438643');
  assert.deepStrictEqual(q643.correctIndices, [1, 3]);
  assert.strictEqual(gradeAnswer(q643, 1).isCorrect, true);
  assert.strictEqual(gradeAnswer(q643, 3).isCorrect, true);
  assert.strictEqual(gradeAnswer(q643, 0).isCorrect, false);
});

test('Проверка сопоставления, дистракторов и перемешивания', () => {
  const q454 = dataset.questions.find((q) => q.sourceQuestionId === 'q438454');
  assert.strictEqual(q454.type, 'matching');
  assert.deepStrictEqual(q454.rightOptions, ['точкой', 'пробелом', 'тире']);
  assert.strictEqual(gradeAnswer(q454, ['тире', 'пробелом', 'пробелом', 'тире']).isCorrect, true);
  const wrong = gradeAnswer(q454, ['точкой', 'пробелом', 'пробелом', 'тире']);
  assert.strictEqual(wrong.isCorrect, false);
  assert.deepStrictEqual(wrong.rowResults, [false, true, true, true]);
});

test('Проверка текстовых вопросов (регистр, пробелы, ё/е)', () => {
  const q557 = dataset.questions.find((q) => q.sourceQuestionId === 'q438557');
  assert.strictEqual(q557.type, 'text');
  assert.strictEqual(gradeAnswer(q557, '  ЖЕСТКОМ   ДИСКЕ ').isCorrect, true);
  assert.strictEqual(gradeAnswer(q557, 'жёстком диске').isCorrect, true);
  assert.strictEqual(gradeAnswer(q557, 'флешке').isCorrect, false);
});

test('Проверка перемешивания вариантов в сессии и сохранения правильности', () => {
  const sample = dataset.questions.slice(0, 30);
  const session = buildSessionQuestions(sample, {
    count: 20,
    shuffleQuestions: true,
    shuffleOptions: true,
  });
  assert.strictEqual(session.length, 20);
  for (const q of session) {
    if (q.type === 'single') {
      const rightOpt = q.displayOptions.find((o) => o.origIndex === q.correctIndices[0]);
      assert.ok(rightOpt);
      assert.strictEqual(gradeAnswer(q, rightOpt.origIndex).isCorrect, true);
    }
  }
});

test('Поиск с нормализацией латинских омоглифов', () => {
  const q643 = dataset.questions.find((q) => q.sourceQuestionId === 'q438643');
  assert.strictEqual(questionMatchesSearch(q643, 'гистограмму'), true);
  assert.strictEqual(questionMatchesSearch(q643, 'диаграмм'), true);
});

test('Распознавание страницы списка тестов («Банк вопросов»)', () => {
  const file1 = path.join(
    ROOT,
    'ОЦГ',
    'Тестирование по разделу 1 Обзор средств цифровой коммуникации.html'
  );
  if (fs.existsSync(file1)) {
    const html = fs.readFileSync(file1, 'utf8');
    const res = parseSyncShareDocument(parseHtmlDom(html), { fileName: path.basename(file1) });
    assert.strictEqual(res.topic.isQuizBankList, false);
    assert.strictEqual(res.questions.length, 51);
  }
});

test('Синтетический HTML с картинкой и последовательностью парсится корректно', () => {
  const syntheticHtml = `
    <main>
      <h1>Просмотр вопросов</h1>
      <p class="text-neutral-600">Тестирование по разделу 99 "Тест"</p>
      <div>Вопросов в тесте: 1</div>
      <div id="q999" class="rounded-lg">
        <div><h2>Вопрос 1</h2></div>
        <div class="px-6 py-6">
          <div class="mb-6"><p>Упорядочите этапы:<br><img src="./test_files/diagram.png"></p></div>
          <div class="space-y-6">
            <div class="bg-neutral-50">
              <h3>Правильный ответ</h3>
              <ol><li>Шаг 1</li><li>Шаг 2</li><li>Шаг 3</li></ol>
            </div>
          </div>
          <p class="text-right">Источник: lms.guap.ru</p>
        </div>
      </div>
    </main>
  `;
  const res = parseSyncShareDocument(parseHtmlDom(syntheticHtml), {
    fileName: 'test.html',
    resolveImageSrc: (s) => s.replace('./test_files/', './assets/images/'),
  });
  assert.strictEqual(res.questions.length, 1);
  const q = res.questions[0];
  assert.strictEqual(q.type, 'sequence');
  assert.deepStrictEqual(q.items, ['Шаг 1', 'Шаг 2', 'Шаг 3']);
  assert.ok(q.promptHtml.includes('./assets/images/diagram.png'));
  assert.strictEqual(hasUserAnswer(q, ['Шаг 1', 'Шаг 2', 'Шаг 3']), true);
  assert.strictEqual(gradeAnswer(q, ['Шаг 1', 'Шаг 2', 'Шаг 3']).isCorrect, true);
  assert.strictEqual(gradeAnswer(q, ['Шаг 2', 'Шаг 1', 'Шаг 3']).isCorrect, false);
});

test('Автономная сборка dist/ocg-trainer.html валидна синтаксически', () => {
  const bundlePath = path.join(ROOT, 'dist', 'ocg-trainer.html');
  assert.ok(fs.existsSync(bundlePath), 'Файл dist/ocg-trainer.html не найден');
  const html = fs.readFileSync(bundlePath, 'utf8');
  assert.ok(html.includes('window.__STANDALONE_LOGO__ = "data:image/svg+xml;base64,'));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.strictEqual(scripts.length, 2);
  for (const s of scripts) {
    new vm.Script(s);
  }

  const pagesPath = path.join(ROOT, 'dist', 'index.html');
  assert.ok(fs.existsSync(pagesPath), 'Файл dist/index.html не найден');
  assert.strictEqual(fs.readFileSync(pagesPath, 'utf8'), html);
  assert.ok(html.includes('const isStandaloneBuild = Boolean(standaloneDataset);'));
  assert.ok(/isStandaloneBuild\s*\?\s*''/.test(html), 'Админ-кнопка не отключена для статической сборки');
});

// HTTP Server handler smoke test
async function testServerHandler() {
  const invoke = (urlPath) =>
    new Promise((resolve) => {
      const chunks = [];
      let statusCode = 0;
      let headers = {};
      const res = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(Buffer.from(chunk));
          cb();
        },
      });
      res.writeHead = (code, hdrs = {}) => {
        statusCode = code;
        headers = hdrs;
      };
      res.on('finish', () => {
        resolve({ status: statusCode, headers, data: Buffer.concat(chunks).toString('utf8') });
      });
      handleRequest({ url: urlPath }, res);
    });

  const r1 = await invoke('/');
  assert.strictEqual(r1.status, 200);
  assert.ok(r1.data.includes('<div id="app">'));

  const r2 = await invoke('/src/data/questions.json');
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(JSON.parse(r2.data).totalQuestions, 378);

  const r3 = await invoke('/src/js/app.js');
  assert.strictEqual(r3.status, 200);

  const logo = await invoke('/s_guap-sign.svg');
  assert.strictEqual(logo.status, 200);
  assert.match(logo.data, /<svg/);

  const r4 = await invoke('/../outside.txt');
  assert.strictEqual(r4.status, 403);

  passed++;
  console.log('✓ Обработчик сервера отдаёт главную страницу, скрипты и базу вопросов (200 OK)');
}

await testServerHandler();

async function testSharedDatasetAndAdminPasswordRequirement() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocg-server-test-'));
  const customTopicsPath = path.join(tempDir, 'custom-topics.json');
  const previousPassword = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;

  try {
    fs.writeFileSync(
      customTopicsPath,
      JSON.stringify([
        {
          topic: {
            id: 'custom-vps-topic',
            title: 'Проверка общей темы',
            shortTitle: 'Проверка',
            sectionNumber: null,
            actualCount: 0,
            statedCount: 0,
          },
          questions: [],
        },
      ]),
      'utf8'
    );

    const handler = createRequestHandler({ customTopicsPath });
    const invoke = (url, method = 'GET') =>
      new Promise((resolve) => {
        const chunks = [];
        let statusCode = 0;
        const res = new Writable({
          write(chunk, _enc, cb) {
            chunks.push(Buffer.from(chunk));
            cb();
          },
        });
        res.writeHead = (code) => {
          statusCode = code;
        };
        res.on('finish', () => {
          resolve({ status: statusCode, data: Buffer.concat(chunks).toString('utf8') });
        });
        handler({ url, method, headers: {} }, res);
      });

    const datasetResponse = await invoke('/api/dataset');
    const dataset = JSON.parse(datasetResponse.data);
    assert.ok(dataset.topics.some((topic) => topic.id === 'custom-vps-topic'));

    const statusResponse = await invoke('/api/admin/status');
    assert.strictEqual(JSON.parse(statusResponse.data).passwordConfigured, false);

    const loginResponse = await invoke('/api/admin/login', 'POST');
    assert.strictEqual(loginResponse.status, 503);

    const deleteResponse = await invoke('/api/admin/topics/custom-vps-topic', 'DELETE');
    assert.strictEqual(deleteResponse.status, 401);

    passed++;
    console.log('✓ Общая база отдаёт серверные разделы, а админ-доступ без пароля отключён');
  } finally {
    if (previousPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previousPassword;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await testSharedDatasetAndAdminPasswordRequirement();
console.log(`\nВсе проверки пройдены успешно: ${passed}/${passed}`);

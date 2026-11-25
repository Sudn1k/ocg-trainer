import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');

function stripImportsAndExports(code) {
  return code
    .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '')
    .replace(/^\s*export\s+(?=(function|const|let|var|class|async)\b)/gm, '')
    .replace(/^\s*export\s+default\s+/gm, '');
}

export function buildStandalone() {
  fs.mkdirSync(DIST_DIR, { recursive: true });

  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'main.css'), 'utf8');
  const logo = fs.readFileSync(path.join(ROOT, 's_guap-sign.svg')).toString('base64');
  const dataJson = fs.readFileSync(path.join(ROOT, 'src', 'data', 'questions.json'), 'utf8');
  const engineJs = stripImportsAndExports(
    fs.readFileSync(path.join(ROOT, 'src', 'js', 'quiz-engine.js'), 'utf8')
  );
  const appJs = stripImportsAndExports(
    fs.readFileSync(path.join(ROOT, 'src', 'js', 'app.js'), 'utf8')
  );

  const safeDataJson = dataJson.replace(/<\/script>/gi, '<\\/script>');
  const bundleCode = `
(function () {
  'use strict';
  const INITIAL_DATASET = window.__STANDALONE_DATASET__;

  const {
    buildSessionQuestions,
    formatPromptHtmlForDisplay,
    gradeAnswer,
    hasUserAnswer,
    questionMatchesSearch,
  } = (function () {
${engineJs}
    return {
      buildSessionQuestions,
      formatPromptHtmlForDisplay,
      gradeAnswer,
      hasUserAnswer,
      questionMatchesSearch,
    };
  })();

  (function () {
${appJs}
  })();
})();
`.replace(/<\/script>/gi, '<\\/script>');

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ОЦГ Тренажёр — Подготовка к итоговому тестированию</title>
  <style>
${css}
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
    window.__STANDALONE_LOGO__ = "data:image/svg+xml;base64,${logo}";
    window.__STANDALONE_DATASET__ = ${safeDataJson};
  </script>
  <script>
${bundleCode}
  </script>
</body>
</html>
`;

  const outPath = path.join(DIST_DIR, 'ocg-trainer.html');
  fs.writeFileSync(outPath, html, 'utf8');
  fs.writeFileSync(path.join(DIST_DIR, 'index.html'), html, 'utf8');
  const assetsPath = path.join(ROOT, 'assets');
  if (fs.existsSync(assetsPath)) {
    fs.cpSync(assetsPath, path.join(DIST_DIR, 'assets'), { recursive: true });
  }
  console.log(`Автономная сборка создана: ${outPath} (${Math.round(html.length / 1024)} КБ)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildStandalone();
}

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ui = fileURLToPath(new URL('../services/loom-demo/', import.meta.url));
const requireUi = createRequire(new URL('../services/loom-demo/package.json', import.meta.url));
const requireEslint = createRequire(requireUi.resolve('eslint'));
const requireParser = createRequire(
  createRequire(requireUi.resolve('typescript-eslint')).resolve('@typescript-eslint/parser'),
);
const consumers = [
  ['eslint', requireEslint],
  ['eslint config array', createRequire(requireEslint.resolve('@eslint/config-array'))],
  ['typescript-estree', createRequire(requireParser.resolve('@typescript-eslint/typescript-estree'))],
];

// The override crosses a major version. Check the APIs actually used by the lint tree.
for (const [name, consumer] of consumers) {
  test(`${name} resolves the patched named/class glob API`, () => {
    const version = consumer('minimatch/package.json').version;
    assert.match(version, /^11\./);
    assert.ok(Number(version.split('.')[1]) > 0 || Number(version.split('.')[2]) >= 1);
    const { minimatch, Minimatch } = consumer('minimatch');
    const cases = [
      ['src/landing/Landing.tsx', '**/*.{ts,tsx}', true],
      ['src/api/client.test.ts', '**/*.{ts,tsx}', true],
      ['src/landing/file with spaces.tsx', 'src/{landing,components}/**/*.tsx', true],
      ['src/.internal/check.ts', 'src/**/*.ts', true],
      ['src/landing/Landing.css', '**/*.{ts,tsx}', false],
      ['dist/assets/index.js', 'dist/**', true],
      ['src/api/client.ts', '**/node_modules/**', false],
    ];
    for (const optimizationLevel of [0, 1, 2]) {
      for (const [file, pattern, expected] of cases) {
        const options = { dot: true, optimizationLevel };
        assert.equal(minimatch(file, pattern, options), expected);
        assert.equal(new Minimatch(pattern, options).match(file), expected);
      }
    }
    assert.equal(minimatch('C:/Repo/SRC/Foo.TSX', '**/src/**/*.tsx', { nocase: true }), true);
    assert.equal(new Minimatch('src/**/*.tsx', { partial: true }).match('src/landing'), true);
  });
}

const { ESLint } = requireUi('eslint');
const linter = new ESLint({ cwd: ui });

test('lint still covers source and excludes generated assets', async () => {
  assert.equal(await linter.isPathIgnored('src/landing/Landing.tsx'), false);
  assert.equal(await linter.isPathIgnored('src/api/client.ts'), false);
  assert.equal(await linter.isPathIgnored('dist/assets/index.js'), true);
  const config = await linter.calculateConfigForFile('src/landing/Landing.tsx');
  assert.equal(config.rules['react-hooks/rules-of-hooks'][0], 2);
  assert.equal(config.rules['react-hooks/exhaustive-deps'][0], 1);
  assert.equal(config.rules['@typescript-eslint/no-explicit-any'][0], 2);
  assert.equal(config.rules['react-refresh/only-export-components'][0], 2);
});

async function messages(source) {
  const [result] = await linter.lintText(source, { filePath: 'src/dependency-canary.tsx' });
  assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
  return result.messages;
}

test('core, TypeScript and React Refresh violations are still detected', async () => {
  const found = new Set((await messages(`
    export function Probe() {
      debugger;
      const value: any = 1;
      return <div>{value}</div>;
    }
    export const notAComponent = {};
  `)).map((message) => message.ruleId));
  for (const rule of ['no-debugger', '@typescript-eslint/no-explicit-any', 'react-refresh/only-export-components']) {
    assert.ok(found.has(rule), `Missing lint canary: ${rule}`);
  }
});

test('conditional hooks and missing effect dependencies are still detected', async () => {
  const found = new Set((await messages(`
    import { useEffect } from 'react';
    export function Probe({ enabled, value }: { enabled: boolean; value: number }) {
      if (enabled) useEffect(() => {}, []);
      useEffect(() => { console.log(value); }, []);
      return null;
    }
  `)).map((message) => message.ruleId));
  assert.ok(found.has('react-hooks/rules-of-hooks'));
  assert.ok(found.has('react-hooks/exhaustive-deps'));
});

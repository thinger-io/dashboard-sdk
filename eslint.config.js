import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
    { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'templates/**', 'test-results/**'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: { ...globals.browser, ...globals.node },
        },
        rules: {
            'no-empty': ['error', { allowEmptyCatch: true }],
            '@typescript-eslint/no-unused-vars': [
                'warn',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
            ],
        },
    },
    {
        files: ['test/**'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-this-alias': 'off',
        },
    },
    prettierConfig,
);

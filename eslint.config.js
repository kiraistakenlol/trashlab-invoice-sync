import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['node_modules', 'local'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-nested-ternary': 'error',
      curly: 'error',
      'max-depth': ['error', 3],
    },
  },
  {
    files: ['src/**'],
    rules: {
      'no-console': 'error',
      complexity: ['error', 10],
      'max-lines-per-function': ['error', { max: 40, skipBlankLines: true, skipComments: true }],
    },
  },
  { files: ['qbo-playground/src/**'], rules: { '@typescript-eslint/no-explicit-any': 'off' } }
)

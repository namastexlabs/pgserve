import unusedImports from 'eslint-plugin-unused-imports';

export default [
  {
    files: ['src/**/*.js', 'bin/**/*.js', 'tests/**/*.js'],
    plugins: {
      'unused-imports': unusedImports,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      // Dead imports - ERROR
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
        },
      ],

      // Code quality
      'no-unused-vars': 'off', // Handled by unused-imports
      'no-console': 'off', // We use console in CLI
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': 'warn',
      'no-empty': 'warn',
      'no-duplicate-case': 'error',
      'no-fallthrough': 'warn',
      'eqeqeq': ['warn', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'warn',
    },
  },
  {
    ignores: ['node_modules/', 'data/', 'test-data-*/', '.genie/'],
  },
];

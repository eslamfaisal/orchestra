export default {
  '*.{ts,mjs,cjs}': ['eslint --fix', 'prettier --write'],
  '*.{json,yaml,yml,md}': 'prettier --write --ignore-unknown',
};

export const codeFiles = "**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}";

const exportedDeclaration = "ExportNamedDeclaration[declaration.kind=/^(const|let)$/]";
const declarations = ["const", "let", { selector: exportedDeclaration }];

const multilineDeclarations = [
  "multiline-const",
  "multiline-let",
  { selector: exportedDeclaration, lineMode: "multiline" },
];

export const spacingRules = {
  "@stylistic/padding-line-between-statements": [
    "error",
    { blankLine: "always", prev: "block-like", next: "*" },
    { blankLine: "always", prev: "*", next: "block-like" },
    { blankLine: "any", prev: "case", next: ["case", "default"] },
    { blankLine: "always", prev: multilineDeclarations, next: declarations },
    { blankLine: "always", prev: declarations, next: multilineDeclarations },
  ],
  "@stylistic/lines-between-class-members": ["error", "always", { exceptAfterSingleLine: true }],
};

const declarations = ["const", "let"];
const multilineDeclarations = ["multiline-const", "multiline-let"];

export const declarationSpacing = [
  { blankLine: "always", prev: multilineDeclarations, next: declarations },
  { blankLine: "always", prev: declarations, next: multilineDeclarations },
];

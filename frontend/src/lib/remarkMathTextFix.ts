import { visit } from 'unist-util-visit';

const replaceTextWithMath = (value: string): string =>
  value.replace(/\\text\s*\{([^{}]*)\}/g, (match, inner: string) => {
    if (!inner || !/[_^]/.test(inner)) return match;
    return `\\mathrm{${inner}}`;
  });

export const fixMathText = (value: string): string => replaceTextWithMath(value);

export const remarkMathTextFix = () => {
  return (tree: any) => {
    visit(tree, ['inlineMath', 'math'], (node: any) => {
      if (typeof node.value === 'string') {
        node.value = replaceTextWithMath(node.value);
      }
    });
  };
};

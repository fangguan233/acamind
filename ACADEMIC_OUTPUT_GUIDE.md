# Academic Output Guide (Math Rendering)

This fork is optimized for student/academic use cases. It renders common math formats into readable formulas.

## Inline / Display LaTeX (recommended)

- Inline: `$\\frac{a}{b}$`
- Display: `$$\\int_0^1 x^2\\,dx$$`

> Notes:
> - Math rendering is controlled by `features.latex` in `.chainlit/config.toml`.
> - If you see raw `$...$`, check that `features.latex = true`.

## Force rendering with fenced code blocks

When an LLM tends to wrap answers in code blocks, use explicit fences so the UI can render them instead of showing raw source.

### Render Markdown

```markdown
| a | b |
|---|---|
| 1 | 2 |

$$E = mc^2$$
```

### Render LaTeX

```latex
\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}
```

### Render AsciiMath

```asciimath
sqrt(x^2 + 1)
```

### Render MathML

> Tip:
> - Use ```mathml (recommended). ```xml / ```html also works as long as the block contains `<math>...</math>`.
> - For consistent rendering across browsers, MathML blocks are converted to LaTeX and rendered via KaTeX when possible.
> - If you paste a full XHTML/HTML document (contains `<html>...</html>`), the UI renders it inside an iframe and **trusts `<style>`** so your academic layout works (scripts are still blocked).

```mathml
<math xmlns="http://www.w3.org/1998/Math/MathML">
  <mrow>
    <msup><mi>x</mi><mn>2</mn></msup>
    <mo>+</mo>
    <mn>1</mn>
  </mrow>
</math>
```

### Render SVG

```svg
<svg viewBox="0 0 120 40" xmlns="http://www.w3.org/2000/svg">
  <text x="10" y="25" font-size="16">Hello SVG</text>
</svg>
```

### Render TikZ (LaTeX → SVG)

```tikz
\\draw (0,0) circle (1cm);
```

Or paste a full LaTeX snippet:

```latex
\\begin{document}
\\begin{tikzpicture}
\\draw (0,0) circle (1cm);
\\end{tikzpicture}
\\end{document}
```

### Render Chemfig (LaTeX → SVG)

```chemfig
H-C(-[2]H)(-[6]H)-H
```

> Also supported (inline LaTeX): `\\ce{...}` / `\\pu{...}` (KaTeX mhchem).

## Source vs Rendered

For `markdown`, `latex`, `asciimath`, `mathml`, `svg`, `tikz`, and `chemfig` code blocks, the UI provides a `Rendered`/`Source` toggle so users can both read the formatted result and copy the original source.

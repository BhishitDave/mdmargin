// The guide shown when no file is open. It doubles as a playground for every feature.
window.WELCOME_MD = `# Welcome to Margin

A quiet place to read, mark up and edit Markdown. ==Everything you see here is a normal .md file== — including this highlight.<!--mdr:note {"text":"Sticky notes live in the margin. Click me to edit, or pick a colour.","color":"yellow"}-->

## Getting around

- **Open a folder** from the sidebar to browse all of its Markdown files, or drop a file anywhere on the window.
- The **Outline** tab follows your headings; the **Marks** tab collects bookmarks, notes and highlights.
- Press <kbd>⌘.</kbd> for reading mode, and <kbd>Esc</kbd> to leave it. <!--mdr:bookmark {"label":"Shortcuts live here"}-->

## Marking up

Select any text and a small toolbar appears:

1. Pick a colour to <mark data-hl="green">highlight the selection</mark>.
2. Add a **sticky note** tied to that passage.
3. Drop a **bookmark** so you can jump back later — or press <kbd>⌘D</kbd> to bookmark wherever you are.

Click an existing highlight to recolour or remove it.

## Editing

Switch to **Edit** (<kbd>⌘E</kbd>) and type straight into the page. Markdown shortcuts work as you write:

| Type this | To get |
| --- | --- |
| \`# \` … \`###### \` | Headings |
| \`- \` or \`1. \` | Lists |
| \`> \` | Quote |
| \`\`\` then Enter | Code block |
| \`---\` then Enter | Divider |

- [x] Tick boxes work in any mode
- [ ] Try this one

Prefer the raw text? **Markdown** mode (<kbd>⌘/</kbd>) shows the source. Save with <kbd>⌘S</kbd>.

> Only the paragraphs you touch are rewritten when you save. Everything else is written back exactly as it was.

## Sharing a clean copy

Annotations are stored inside the file: highlights as \`==text==\`, notes and bookmarks as invisible HTML comments. Before sharing, open the **⋯** menu and choose **Save clean copy** or **Copy clean Markdown** to get the document without any of them.

## Make it yours

The **Aa** button changes theme, typeface, text size, line height and column width.

\`\`\`js
// Code blocks keep their formatting
const calm = reading.filter(noise => !noise);
\`\`\`

---

*Open a file to begin.*
`;

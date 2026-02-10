import { marked } from "marked";
import puppeteer from "puppeteer";
import { readFile } from "fs/promises";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import hljs from "highlight.js";

// Types derived from Gantha core (replicated here for standalone usage)
export interface Chapter {
  id: string;
  title: string;
  subtitle: string;
  file: string;
}

export interface BookData {
  title: string;
  chapters: Chapter[];
  plugins?: string[];
}

export interface PluginContext {
  on(hook: 'beforeBuild', callback: () => void | Promise<void>): void;
  on(hook: 'afterBuild', callback: () => void | Promise<void>): void;
  on(hook: 'processMarkdown', callback: (markdown: string) => string | Promise<string>): void;
  on(hook: 'processHTML', callback: (html: string) => string | Promise<string>): void;
  bookData: BookData;
  projectRoot: string;
}

// Configure marked renderer to use highlight.js for marked v15
const renderer = new marked.Renderer();

// Override the code function - marked v15 passes a code object
renderer.code = function (code: {
  text: string;
  lang?: string;
  escaped?: boolean;
}) {
  const { text, lang } = code;

  // Handle mermaid diagrams - create a div with mermaid class (avoids pre styling)
  if (lang === "mermaid") {
    return `<div class="mermaid">${text}</div>\n`;
  }

  const validLang = lang && hljs.getLanguage(lang) ? lang : "plaintext";
  const highlighted = hljs.highlight(text, { language: validLang }).value;
  return `<pre><code class="hljs language-${validLang}">${highlighted}</code></pre>\n`;
};

marked.setOptions({
  renderer: renderer,
});

// Configuration interface matching book.toml
interface BookConfig {
  title?: string;
  subtitle?: string;
  author?: string;
  cover?: string;
  header?: string;
  footer?: string;
  margin_top?: number;
  margin_bottom?: number;
  margin_left?: number;
  margin_right?: number;
  font_size?: number;
  font_family?: string;
  page_size?: string;
  orientation?: "P" | "L";
  line_height?: number;
  generate_toc?: boolean;
  enable_bookmarks?: boolean;
}

// Simple TOML parser (basic implementation)
function parseToml(tomlString: string): BookConfig {
  const config: BookConfig = {};
  const lines = tomlString.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (trimmed.startsWith("#") || trimmed === "" || trimmed.startsWith("[")) {
      continue;
    }

    // Parse key = value pairs
    const match = trimmed.match(/^(\w+)\s*=\s*(.*)$/);
    if (match) {
      const [, key, value] = match;
      let parsedValue: any = value.trim();

      // Remove quotes from strings
      if (
        (parsedValue.startsWith('"') && parsedValue.endsWith('"')) ||
        (parsedValue.startsWith("'") && parsedValue.endsWith("'"))
      ) {
        parsedValue = parsedValue.slice(1, -1);
      }
      // Parse booleans
      else if (parsedValue === "true") {
        parsedValue = true;
      } else if (parsedValue === "false") {
        parsedValue = false;
      }
      // Parse numbers
      else if (!isNaN(Number(parsedValue))) {
        parsedValue = Number(parsedValue);
      }

      config[key as keyof BookConfig] = parsedValue;
    }
  }

  return config;
}

// Output path
const OUTPUT_PDF = "build/book.pdf";

// Convert placeholders to Puppeteer format
function convertPlaceholders(
  template: string | undefined,
  marginLeft: number,
  marginRight: number,
  config: BookConfig,
): string {
  if (!template) return '<div style="font-size: 9pt;"></div>';

  const converted = template
    .replace(/\{title\}/g, config.title || "")
    .replace(/\{author\}/g, config.author || "")
    .replace(/\{PAGENO\}/g, '<span class="pageNumber"></span>')
    .replace(/\{nbpg\}/g, '<span class="totalPages"></span>')
    .replace(/\{nbpages\}/g, '<span class="totalPages"></span>');

  // Wrap in a div with proper padding to align with content
  // Use padding instead of margin for Puppeteer header/footer
  return `<div style="padding-left: ${marginLeft}mm; padding-right: ${marginRight}mm; width: 100%; box-sizing: border-box;">${converted}</div>`;
}

// Convert markdown to HTML with professional book styling
function markdownToHTML(markdown: string, config: BookConfig, basePath?: string): string {
  // Parse markdown
  let htmlContent = marked.parse(markdown) as string;

  const fontSize = config.font_size || 11;
  const userFont = config.font_family ? `${config.font_family}, ` : "";
  // Include CJK fonts in fallback
  const fontFamily = `${userFont}Lora, "Noto Sans SC", "Noto Sans JP", Georgia, serif`;
  const headingFont = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif"; // Sans-serif for headings
  const monoFont = `'Fira Code', 'Source Code Pro', 'Courier New', Courier, ${userFont}monospace`;
  const lineHeight = config.line_height || 1.6;
  const primaryColor = "#2d3436";
  const totalVMargin = (config.margin_top || 30) + (config.margin_bottom || 30);

  // Book header sections
  // Book header sections
  let coverPage = "";
  if (config.cover) {
    // Full page cover image
    coverPage = `
      <div class="page cover-page full-bleed">
        <img src="${config.cover}" class="cover-image-full" />
      </div>
    `;
  }

  // Unified Title and Copyright Page
  let titlePage = "";
  if (config.title) {
    titlePage = `
      <div class="page title-page">
        <div class="title-content">
          <h1 class="book-title">${config.title}</h1>
          ${config.subtitle ? `<h2 class="book-subtitle">${config.subtitle}</h2>` : ""}
          <div class="book-author">${config.author || ""}</div>
        </div>

        <div class="copyright-footer">
          <p>&copy; ${new Date().getFullYear()} ${config.author || ""}. All rights reserved.</p>
          <p>www.saturngod.net</p>
        </div>
      </div>
    `;
  }

  const tocPlaceholder = config.generate_toc
    ? '<div id="toc-placeholder"></div>'
    : "";

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${config.title || "Book"}</title>
  ${basePath ? `<base href="file://${basePath}/">` : ''}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400;1,700&family=Inter:wght@400;500;600;700;800&family=Fira+Code:wght@300;400;500&family=Noto+Sans+Myanmar:wght@400;700&family=Noto+Sans+SC:wght@400;700&family=Noto+Sans+JP:wght@400;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary-color: ${primaryColor};
      --text-color: #1a1a1a;
      --muted-color: #666;
      --border-color: #eaeaea;
      --font-body: ${fontFamily}, 'Noto Sans Myanmar', serif;
      --font-heading: ${headingFont}, 'Noto Sans Myanmar', sans-serif;
      --font-mono: ${monoFont};
    }

    /*
      We use Puppeteer's margin options for the main document to allow headers/footers.
      When preferCSSPageSize is true (enabled by bookmarks), @page rules take precedence.
      So we RESTORE the margins from config here.
    */
    @page {
      size: ${config.page_size || "A4"} ${config.orientation === "L" ? "landscape" : "portrait"};
      margin-top: ${config.margin_top || 30}mm;
      margin-right: ${config.margin_right || 25}mm;
      margin-bottom: ${config.margin_bottom || 30}mm;
      margin-left: ${config.margin_left || 30}mm;
    }

    /* Named page for Cover to allow full bleed (no margins) */
    @page cover {
      margin: 0;
    }

    * { box-sizing: border-box; }

    body {
      font-family: var(--font-body);
      font-size: ${fontSize}pt;
      line-height: ${lineHeight};
      color: var(--text-color);
      margin: 0;
      padding: 0;
      -webkit-font-smoothing: antialiased;
    }

    /* Content wrapper */
    .content {
      width: 100%;
    }

    /* Cover Page Styling */
    .cover-page {
      page: cover; /* Use the named page style */
      display: flex;
      justify-content: center;
      align-items: center;
      width: 100%;
      height: 100vh;
      page-break-after: always;
      overflow: hidden;
    }

    .cover-image-full {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }

    /* Title Page (Combined Title + Copyright) */
    .title-page {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      align-items: center;
      text-align: center;
      height: calc(100vh - ${totalVMargin + 10}mm);
      page-break-after: always;
      overflow: hidden;
    }

    .title-content {
      padding-top: 8vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 100%;
      max-width: 80%;
    }

    .book-title {
      font-family: var(--font-heading);
      font-size: 3.5rem;
      font-weight: 800;
      line-height: 1.1;
      margin-bottom: 0.2em;
      color: var(--primary-color);
      letter-spacing: -0.02em;
    }

    .book-subtitle {
      font-family: var(--font-heading);
      font-size: 1.2rem;
      font-weight: 400;
      color: var(--muted-color);
      margin-top: 0;
    }

    .book-author {
      font-family: var(--font-heading);
      font-size: 1.2rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-top: 3rem;
    }

    .copyright-footer {
      font-size: 0.9rem;
      color: var(--muted-color);
      margin-bottom: 2em;
      text-align: center;
    }

    .copyright-footer p {
      margin-bottom: 0.5em;
      text-align: center;
    }

    /* Headings */
    h1, h2, h3, h4, h5, h6 {
      font-family: var(--font-heading);
      font-weight: 700;
      margin-top: 2em;
      margin-bottom: 0.8em;
      line-height: 1.25;
      page-break-after: avoid;
    }

    h1 {
      font-size: 2.2rem;
      border-bottom: 3px solid var(--primary-color);
      padding-bottom: 0.3em;
      margin-top: 0;
      page-break-before: always;
    }

    /* Exceptions for page breaks */
    h1:first-of-type, .toc h1 { page-break-before: avoid; }

    h2 {
      font-size: 1.6rem;
      color: #333;
      padding-bottom: 0.2em;
    }

    h3 { font-size: 1.3rem; color: #444; }

    /* Paragraphs */
    p {
      margin-bottom: 1.2em;
      text-align: justify;
      hyphens: auto;
      widows: 2;
      orphans: 2;
    }

    /* IMAGES: Critical fixes */
    img {
      max-width: 100%;       /* Never exceed page width */
      height: auto;          /* Maintain aspect ratio */
      max-height: 85vh;      /* Don't be taller than a page */
      display: block;
      margin: 1.5em auto;    /* Center images */
      page-break-inside: avoid;
    }

    /* Code Blocks */
    pre {
      background: #282c34;
      border-radius: 6px;
      padding: 1.2rem;
      margin: 1.5em 0;
      overflow-x: auto;
      border: 1px solid #1a1c22;
      page-break-inside: avoid; /* Try to keep code blocks together */
      box-shadow: 0 2px 8px rgba(0,0,0,0.05);
    }

    code {
      font-family: var(--font-mono);
      font-size: 0.85em;
      background: rgba(0,0,0,0.05);
      padding: 0.2em 0.4em;
      border-radius: 3px;
    }

    pre code {
      background: transparent;
      padding: 0;
      color: #abb2bf;
      display: block;
      line-height: 1.45;
      white-space: pre-wrap;
    }

    /* Syntax Highlighting */
    .hljs-keyword { color: #c678dd; }
    .hljs-string { color: #98c379; }
    .hljs-title { color: #61afef; }
    .hljs-comment { color: #5c6370; font-style: italic; }
    .hljs-number { color: #d19a66; }
    .hljs-function { color: #61afef; }

    /* Admonitions */
    blockquote {
      background: #f8f9fa;
      border-left: 4px solid var(--primary-color);
      margin: 1.5em 0;
      padding: 1rem 1.2rem;
      border-radius: 0 4px 4px 0;
      font-style: italic;
      color: #555;
      page-break-inside: avoid;
    }

    /* Tables */
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 2em 0;
      page-break-inside: avoid;
      font-size: 0.95em;
    }

    th {
      background: #f1f3f5;
      font-family: var(--font-heading);
      text-align: left;
      font-weight: 600;
      color: #495057;
      border-bottom: 2px solid #ccc;
      padding: 0.8rem;
    }

    td {
      padding: 0.8rem;
      border-bottom: 1px solid var(--border-color);
    }

    tr:nth-child(even) { background: #fafbfc; }

    /* TOC */
    .toc { page-break-after: always; }
    .toc-item {
      display: flex;
      justify-content: space-between;
      margin-bottom: 0.5em;
      border-bottom: 1px dotted #ccc;
      align-items: baseline;
    }
    .toc-title { background: white; padding-right: 0.5em; }
    .toc-page { background: white; padding-left: 0.5em; font-weight: bold; }

    @media print {
      body {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
    }
  </style>
</head>
<body>
  ${coverPage}
  ${titlePage}
  ${tocPlaceholder}
  <div class="content">
    ${htmlContent}
  </div>

  <script>
    document.addEventListener('DOMContentLoaded', function() {
      // Dynamic TOC generation
      const tocContainer = document.getElementById('toc-placeholder');
      if (tocContainer) {
        let tocHTML = '<div class="page toc"><h1>Table of Contents</h1><div class="toc-list">';
        // Select headers
        const headers = Array.from(document.querySelectorAll('.content h1, .content h2'));

        headers.forEach((header, index) => {
          const level = header.tagName.toLowerCase();
          // Ensure every header has an ID
          if (!header.id) {
            header.id = 'chapter-' + index;
          }
          const id = header.id;

          tocHTML += \`
            <div class="toc-item toc-level-\${level}" style="margin-left: \${level === 'h2' ? '1.5em' : '0'}">
              <span class="toc-title"><a href="#\${id}" style="color: inherit; text-decoration: none;">\${header.textContent}</a></span>
              <span class="toc-spacer"></span>
            </div>
          \`;
        });

        tocHTML += '</div></div>';
        tocContainer.innerHTML = tocHTML;
      }

      // Cleanup empty paragraphs EXCEPT if they have images or special elements
      const paragraphs = document.querySelectorAll('p');
      paragraphs.forEach(p => {
        // If p has children (like img, strong, etc) we usually want to keep it,
        // unless it's just a <br>.
        if (p.querySelector('img')) return;

        const text = p.textContent.trim();
        if (!text && p.children.length === 0) {
          p.style.display = 'none';
        }
      });
    });
  </script>

  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
    mermaid.initialize({
      startOnLoad: true,
      theme: 'neutral',
      securityLevel: 'loose',
      fontFamily: 'Inter, sans-serif'
    });
  </script>
</body>
</html>
  `;
}

// Main Plugin Initialization
export default {
  init: (context: PluginContext) => {
    console.log('📖 Gantha PDF Plugin Initialized');

    context.on('afterBuild', async () => {
      console.log('Generatig PDF...');
      try {
        // Get project root and book data from context
        const projectRoot = context.projectRoot;
        const bookData = context.bookData;
        const output = resolve(projectRoot, OUTPUT_PDF);

        // Read book.toml configuration
        // Search order:
        // 1. Project root
        // 2. Plugin directory (if pdf.ts is in a plugin dir)
        let config: BookConfig = {};
        const configLocations = [
          resolve(projectRoot, "book.toml"),
          resolve(dirname(fileURLToPath(import.meta.url)), "book.toml")
        ];

        let configPath = "";
        for (const loc of configLocations) {
          try {
            const content = await readFile(loc, "utf-8");
            config = parseToml(content);
            configPath = loc;
            console.log(`Configuration loaded from ${loc}`);
            break;
          } catch (e) {
            // Continue searching
          }
        }

        if (!configPath) {
          console.log("No book.toml found, using default configuration");
        }

        // Resolve cover image path relative to config file location
        if (config.cover && configPath) {
          const coverPath = resolve(dirname(configPath), config.cover);
          // Use file:// protocol for local images in Puppeteer
          config.cover = `file://${coverPath}`;
        }   // Override config titles with toc.json data if available
        if (bookData.title) config.title = bookData.title;

        // Combine markdown files
        let combinedMarkdown = "";
        const mdDir = join(projectRoot, 'md');

        console.log(`Combining ${bookData.chapters.length} chapters...`);

        for (let i = 0; i < bookData.chapters.length; i++) {
          const chapter = bookData.chapters[i];
          if (chapter.file === "cover.md" || chapter.file.endsWith("/cover.md")) {
            continue;
          }
          const chapterPath = join(mdDir, chapter.file);
          try {
            const chapterContent = await readFile(chapterPath, "utf-8");
            combinedMarkdown += chapterContent;

            // Add page break if not the last chapter
            if (i < bookData.chapters.length - 1) {
              combinedMarkdown += "\n\n<div style=\"page-break-after: always;\"></div>\n\n";
            }
          } catch (e) {
            console.warn(`Warning: Could not read chapter ${chapter.file}`);
          }
        }
        // Convert to HTML
        console.log("Converting combined markdown to HTML...");
        // Pass mdDir as base path for images
        const html = markdownToHTML(combinedMarkdown, config, mdDir);

        // Launch Puppeteer
        const browser = await puppeteer.launch({
          headless: true,
          args: ["--no-sandbox", "--disable-setuid-sandbox"],
        });

        const page = await browser.newPage();

        // Write HTML to a temporary file so relative image paths work
        const tempHtmlPath = resolve(projectRoot, "_temp_pdf_content.html");
        await Bun.write(tempHtmlPath, html);

        // Navigate to the HTML file - this allows relative image paths to work
        await page.goto(`file://${tempHtmlPath}`, {
          waitUntil: "networkidle0",
        });

        // Generate PDF with options from config
        const marginTop = config.margin_top || 25.4;
        const marginBottom = config.margin_bottom || 25.4;
        const marginLeft = config.margin_left || 25.4;
        const marginRight = config.margin_right || 25.4;

        console.log(
          `Using margins from book.toml - Top: ${marginTop}mm, Bottom: ${marginBottom}mm, Left: ${marginLeft}mm, Right: ${marginRight}mm`,
        );

        const pdfOptions: any = {
          path: output,
          format: (config.page_size || "A4") as any,
          landscape: config.orientation === "L",
          margin: {
            top: `${marginTop}mm`,
            bottom: `${marginBottom}mm`,
            left: `${marginLeft}mm`,
            right: `${marginRight}mm`,
          },
          printBackground: true,
          displayHeaderFooter: true,
          headerTemplate: convertPlaceholders(
            config.header,
            marginLeft,
            marginRight,
            config,
          ),
          footerTemplate: convertPlaceholders(
            config.footer,
            marginLeft,
            marginRight,
            config,
          ),
        };

        if (config.enable_bookmarks) {
          pdfOptions.preferCSSPageSize = true;
        }

        await page.pdf(pdfOptions);
        await browser.close();

        // Clean up temporary HTML file
        try {
          await Bun.file(tempHtmlPath).delete();
        } catch {
          // Ignore cleanup errors
        }

        console.log(`✓ PDF generated successfully: ${output}`);

      } catch (error) {
        console.error("Failed to generate PDF:", error);
      }
    });
  }
};

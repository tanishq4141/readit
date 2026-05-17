(function () {
  if (typeof marked === "undefined") {
    console.error("marked not loaded");
    return;
  }

  mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    securityLevel: "loose",
    htmlLabels: true,
  });

  marked.use({
    gfm: true,
    breaks: false,
  });

  /** Pull mermaid fences out before HTML parsing so <br/> etc. stay literal. */
  function extractMermaidBlocks(markdown) {
    const blocks = [];
    const stripped = markdown.replace(
      /```mermaid\s*\n([\s\S]*?)```/g,
      function (_, source) {
        const index = blocks.length;
        blocks.push(source.replace(/\r\n/g, "\n").trim());
        return '\n<div data-mermaid-slot="' + index + '"></div>\n';
      },
    );
    return { stripped: stripped, blocks: blocks };
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function mountMermaidSlots(root, blocks) {
    root.querySelectorAll("[data-mermaid-slot]").forEach(function (slot) {
      const index = parseInt(slot.getAttribute("data-mermaid-slot"), 10);
      const source = blocks[index];
      if (source == null) return;

      const diagram = document.createElement("div");
      diagram.className = "mermaid";
      diagram.textContent = source;
      slot.replaceWith(diagram);
    });
  }

  function highlightCodeBlocks(root) {
    if (typeof hljs === "undefined") return;
    root.querySelectorAll("pre code").forEach(function (block) {
      if (!block.closest(".mermaid")) {
        hljs.highlightElement(block);
      }
    });
  }

  async function renderMermaidDiagrams(root) {
    const nodes = Array.from(root.querySelectorAll(".mermaid"));
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const source = node.textContent.trim();
      const renderId = "readit-mermaid-" + i + "-" + Date.now();

      try {
        const result = await mermaid.render(renderId, source);
        const wrap = document.createElement("div");
        wrap.className = "mermaid-wrap";
        wrap.innerHTML = result.svg;
        node.replaceWith(wrap);
      } catch (err) {
        console.error("mermaid block " + i, err);
        const errBox = document.createElement("div");
        errBox.className = "mermaid-error";
        errBox.innerHTML =
          '<p><strong>Diagram could not be rendered</strong></p><pre><code>' +
          escapeHtml(source) +
          "</code></pre>";
        node.replaceWith(errBox);
      }
    }
  }

  window.renderMarkdown = function (markdown) {
    const root = document.getElementById("content");
    if (!root) return;

    const extracted = extractMermaidBlocks(markdown);
    root.innerHTML = marked.parse(extracted.stripped);
    mountMermaidSlots(root, extracted.blocks);

    renderMermaidDiagrams(root)
      .then(function () {
        highlightCodeBlocks(root);
      })
      .catch(function (err) {
        console.error("mermaid render failed", err);
        highlightCodeBlocks(root);
      });
  };
})();

"use strict";

// Minimal Markdown renderer: all input is HTML-escaped before formatting is applied.
(function () {
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function inline(text) {
    const codes = [];
    let s = text.replace(/`([^`]+)`/g, (_m, code) => {
      codes.push(code);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = escapeHtml(s);
    s = s.replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, (_m, label, url) => `<a href="${url}" data-external="1">${label}</a>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
    return s;
  }

  function render(md) {
    const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let para = [];
    let list = null;

    const flushPara = () => {
      if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
      list = null;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = line.match(/^\s*```\s*([\w-]*)/);
      if (fence) {
        flushPara();
        flushList();
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
        const lang = escapeHtml(fence[1] || "");
        out.push(`<pre data-lang="${lang}"><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushPara();
        flushList();
        const level = Math.min(heading[1].length + 2, 6);
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        continue;
      }
      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || numbered) {
        flushPara();
        const tag = bullet ? "ul" : "ol";
        if (!list || list.tag !== tag) {
          flushList();
          list = { tag, items: [] };
        }
        list.items.push((bullet || numbered)[1]);
        continue;
      }
      if (!line.trim()) {
        flushPara();
        flushList();
        continue;
      }
      if (list && /^\s{2,}/.test(line)) {
        list.items[list.items.length - 1] += " " + line.trim();
        continue;
      }
      flushList();
      para.push(line.trim());
    }
    flushPara();
    flushList();
    return out.join("");
  }

  window.renderMarkdown = render;
})();

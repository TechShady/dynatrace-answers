"use strict";

(function () {
  const markdown = window.markdownit({ html: false, linkify: false });
  markdown.renderer.rules.link_open = () => "";
  markdown.renderer.rules.link_close = () => "";
  markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);
  markdown.renderer.rules.table_open = () => '<div class="analysis-table-wrap"><table>';
  markdown.renderer.rules.table_close = () => "</table></div>";

  window.renderMarkdown = (value) => {
    const source = String(value || "")
      .replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "");
    return markdown.render(source);
  };
})();

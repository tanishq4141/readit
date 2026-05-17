import { codeToHtml } from "shiki";

export async function highlightCode(
  code: string,
  lang: string,
): Promise<string> {
  const language = lang || "text";
  try {
    return await codeToHtml(code.trimEnd(), {
      lang: language,
      themes: {
        light: "github-light",
        dark: "github-dark",
      },
      defaultColor: false,
    });
  } catch {
    return await codeToHtml(code.trimEnd(), {
      lang: "text",
      themes: {
        light: "github-light",
        dark: "github-dark",
      },
      defaultColor: false,
    });
  }
}

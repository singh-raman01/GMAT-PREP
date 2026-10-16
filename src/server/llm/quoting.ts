// Untrusted text in a prompt, such as a Book's pages, goes between tags. Any
// tag in the text that the prompts use is broken, whatever its case or
// spacing, so the text can neither close its quote early nor open another.

const PromptTags = ["page", "next-page", "question", "chapter-before"]

const TagStart = new RegExp(`<(?=\\s*/?\\s*(?:${PromptTags.join("|")})\\b)`, "gi")

export const quoteData = (tag: string, text: string, attributes = "") =>
  `<${tag}${attributes}>\n${text.replace(TagStart, "< ")}\n</${tag}>`

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

// The first n characters, or one fewer so a character outside the Basic
// Multilingual Plane, such as a math letter, is not cut in two.
export const headOf = (text: string, n: number) =>
  text.slice(0, n > 0 && isHighSurrogate(text.charCodeAt(n - 1)) ? n - 1 : n)

// The last n characters, on the same terms.
export const tailOf = (text: string, n: number) => {
  const from = Math.max(0, text.length - n)
  return text.slice(isLowSurrogate(text.charCodeAt(from)) ? from + 1 : from)
}

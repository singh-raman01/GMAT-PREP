// A Lesson's page. A subject id such as quant.algebra.linear-equations is
// written with slashes, as a path whose last part has a dot is taken for a
// file and not answered with the app.
export const lessonPath = (subjectId: string, part: "whole" | "methods" = "whole") =>
  `/lessons/${subjectId.split(".").map(encodeURIComponent).join("/")}${part === "methods" ? "/methods" : ""}`

// The subject and part a Lesson page's path names, or undefined for another
// path. No subject id in the Taxonomy ends in "methods".
export const lessonOfPath = (path: string): { readonly subjectId: string; readonly part: "whole" | "methods" } | undefined => {
  const match = /^\/lessons\/(.+?)(\/methods)?$/.exec(path)
  if (match === null) return undefined
  return {
    subjectId: match[1]!.split("/").map((each) => decodeURIComponent(each)).join("."),
    part: match[2] === undefined ? "whole" : "methods"
  }
}

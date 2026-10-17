// This browser's colours and text size (decision 126), set on the html
// element while the page head is read, so the first paint already has them.
// A classic script, as the page's policy allows no inline script and a
// module would run after the first paint. It reads the choice as
// web/src/display.ts does, which takes over once the app runs;
// test/display.test.ts checks that the two agree.
try {
  const saved = JSON.parse(localStorage.getItem("gmat-prep-display"))
  if (typeof saved === "object" && saved !== null) {
    const root = document.documentElement
    if (saved.theme === "light" || saved.theme === "dark") root.dataset.theme = saved.theme
    if (saved.textSize === "larger" || saved.textSize === "largest") root.dataset.textSize = saved.textSize
  }
} catch {
  // Nothing readable is saved, or storage is refused: the defaults stand.
}

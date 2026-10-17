import "@fontsource-variable/atkinson-hyperlegible-next/wght.css"
import "katex/dist/katex.min.css"
import "./styles.css"
import { Component, type ReactNode, StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"
import { startDisplay } from "./display.ts"

// A last resort: a bug in a screen shows this instead of an empty page.
class CrashScreen extends Component<{ readonly children: ReactNode }, { readonly crashed: boolean }> {
  override state = { crashed: false }

  static getDerivedStateFromError() {
    return { crashed: true }
  }

  override componentDidCatch(error: unknown) {
    console.error(error)
  }

  override render() {
    if (!this.state.crashed) return this.props.children
    return (
      <main className="page page-narrow">
        <p className="wordmark">GMAT prep</p>
        <h1>This page stopped working</h1>
        <p className="lede">Reload the page to carry on. Your saved work is not affected.</p>
        <button type="button" className="button" onClick={() => window.location.reload()}>
          Reload page
        </button>
      </main>
    )
  }
}

// This browser's colours and text size, before anything is drawn.
startDisplay()

const root = document.getElementById("root")
if (root === null) throw new Error("index.html has no #root element")

createRoot(root).render(
  <StrictMode>
    <CrashScreen>
      <App />
    </CrashScreen>
  </StrictMode>
)

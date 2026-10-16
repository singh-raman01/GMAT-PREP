import { Schema } from "effect"
import { AddedBook, BookUploadPath, MaxBookBytes, UploadRefused } from "../../../src/api/Books.ts"

// Adds a Book: the PDF goes up as the request body, so the browser can report
// how much has been sent. XMLHttpRequest, unlike fetch, reports upload
// progress.

export type UploadOutcome =
  | { readonly _tag: "Added"; readonly added: AddedBook }
  | { readonly _tag: "Refused"; readonly message: string }
  // The Curator unlock ended; the page asks for the passphrase again.
  | { readonly _tag: "Locked" }
  | { readonly _tag: "Unreachable" }

const decodeAdded = Schema.decodeUnknownOption(Schema.fromJsonString(AddedBook))
const decodeRefused = Schema.decodeUnknownOption(Schema.fromJsonString(UploadRefused))

export const maxMegabytes = Math.round(MaxBookBytes / 1024 / 1024)

// What the server's guard says in plain text, before the upload is read.
const guardMessage = (status: number) => {
  switch (status) {
    case 413:
      return `The file is larger than ${maxMegabytes} MB.`
    case 415:
      return "The file is not a PDF."
    default:
      return `The app refused the file (${status}). Reload the page and try again.`
  }
}

export const uploadBook = (
  file: File,
  details: { readonly title: string; readonly edition: string; readonly official: boolean },
  onProgress: (fraction: number) => void
): Promise<UploadOutcome> =>
  new Promise((resolve) => {
    const query = new URLSearchParams({
      title: details.title,
      edition: details.edition,
      official: String(details.official)
    })
    const request = new XMLHttpRequest()
    request.open("POST", `${BookUploadPath}?${query}`)
    request.setRequestHeader("content-type", "application/pdf")
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total)
    }
    request.onerror = () => resolve({ _tag: "Unreachable" })
    request.onload = () => {
      const added = decodeAdded(request.responseText)
      if (added._tag === "Some") return resolve({ _tag: "Added", added: added.value })
      const refused = decodeRefused(request.responseText)
      if (refused._tag === "Some") {
        return resolve(
          refused.value.problem === "not-unlocked" ? { _tag: "Locked" } : { _tag: "Refused", message: refused.value.message }
        )
      }
      resolve({ _tag: "Refused", message: guardMessage(request.status) })
    }
    request.send(file)
  })

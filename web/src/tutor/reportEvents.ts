// Tells the list of the Learner's reports that one was sent, so it reads
// itself again without a reload.

const reports = new EventTarget()

export const reportSent = () => {
  reports.dispatchEvent(new Event("sent"))
}

export const onReportSent = (listener: () => void) => {
  reports.addEventListener("sent", listener)
  return () => reports.removeEventListener("sent", listener)
}

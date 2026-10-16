import { useId, useMemo, useState } from "react"
import { type Dataset, type SortBy, sortRows } from "../../../src/api/dataset.ts"

// A Dataset as a table. A Table Analysis table sorts by any column, by
// value, so 1,200 comes after 980; choosing the same column again reverses
// the order. The cells show what the Book prints.

const orderWords = (by: SortBy) => {
  const ascending = by.direction === "ascending"
  switch (by.type) {
    case "text":
      return ascending ? "A to Z" : "Z to A"
    case "date":
      return ascending ? "earliest first" : "latest first"
    default:
      return ascending ? "lowest first" : "highest first"
  }
}

export const DataTable = (
  { dataset, sortable, caption }: {
    readonly dataset: Dataset
    readonly sortable: boolean
    readonly caption?: string
  }
) => {
  const [by, setBy] = useState<SortBy>()
  const rows = useMemo(() => (by === undefined ? [...dataset.rows] : sortRows(dataset.rows, by)), [dataset, by])
  const status = useId()
  const sortBy = (column: number) => {
    const type = dataset.columns[column]!.type
    setBy((current) =>
      current?.column === column
        ? { ...current, direction: current.direction === "ascending" ? "descending" : "ascending" }
        : { column, type, direction: type === "text" || type === "date" ? "ascending" : "descending" }
    )
  }
  const numeric = (column: number) => dataset.columns[column]!.type !== "text" && dataset.columns[column]!.type !== "date"
  return (
    <div className="data-table-wrap">
      <table className="data-table" aria-describedby={sortable ? status : undefined}>
        {caption !== undefined && <caption className="visually-hidden">{caption}</caption>}
        <thead>
          <tr>
            {dataset.columns.map((column, index) => (
              <th
                key={index}
                scope="col"
                className={numeric(index) ? "number" : undefined}
                aria-sort={by?.column === index ? by.direction : undefined}
              >
                {sortable
                  ? (
                    <button type="button" className="sort-button" onClick={() => sortBy(index)}>
                      {column.name}
                      {column.unit !== "" && <span className="column-unit">{column.unit}</span>}
                      <span className="sort-mark" aria-hidden="true">
                        {by?.column === index ? (by.direction === "ascending" ? "▲" : "▼") : "↕"}
                      </span>
                    </button>
                  )
                  : (
                    <>
                      {column.name}
                      {column.unit !== "" && <span className="column-unit">{column.unit}</span>}
                    </>
                  )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) =>
                index === 0
                  ? <th key={index} scope="row" className={numeric(index) ? "number" : undefined}>{cell.text}</th>
                  : <td key={index} className={numeric(index) ? "number" : undefined}>{cell.text}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {sortable && (
        <p id={status} className="hint" aria-live="polite">
          {by === undefined
            ? "Choose a column heading to sort by it."
            : `Sorted by ${dataset.columns[by.column]!.name}, ${orderWords(by)}.`}
        </p>
      )}
    </div>
  )
}

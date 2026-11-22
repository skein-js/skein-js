import { createRenderer, useBoundProp } from "@json-render/react";
import { useId } from "react";

import { catalog } from "../catalog.js";

export const GeneratedUi = createRenderer(catalog, {
  Card: ({ element: { props }, children }) => (
    <article className="ui-card">
      <h2>{props.title}</h2>
      {children}
    </article>
  ),
  Text: ({ element: { props } }) => <p>{props.text}</p>,
  Grid: ({ element: { props }, children }) => (
    <div
      className="metric-grid"
      style={{ gridTemplateColumns: `repeat(${props.columns}, minmax(0, 1fr))` }}
    >
      {children}
    </div>
  ),
  Metric: ({ element: { props } }) => (
    <section className="metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <small>{props.detail}</small>
    </section>
  ),
  Table: ({ element: { props } }) => (
    <div className="table-scroll">
      <table>
        <caption>{props.caption}</caption>
        <thead>
          <tr>
            {props.columns.map((column, index) => (
              <th key={index} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, column) => (
                <td key={column}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ),
  TaskList: ({ element: { props } }) => (
    <ol className="task-list">
      {(props.tasks ?? []).map((task, index) => (
        <li key={index}>
          <span className="task-number">{String(index + 1).padStart(2, "0")}</span>
          <span>{task}</span>
        </li>
      ))}
    </ol>
  ),
  Button: ({ element: { props }, emit }) => (
    <button type="button" onClick={() => emit("press")}>
      {props.label}
    </button>
  ),
  FeedbackForm: function FeedbackForm({ element: { props }, bindings, emit }) {
    const [value, setValue] = useBoundProp(props.value, bindings?.["value"]);
    const id = useId();
    return (
      <form
        className="feedback"
        onSubmit={(event) => {
          event.preventDefault();
          emit("submit");
        }}
      >
        <label htmlFor={id}>{props.label}</label>
        <div className="input-row">
          <input
            id={id}
            value={value ?? ""}
            maxLength={2000}
            onChange={(event) => setValue(event.target.value)}
            required
            placeholder="Describe a change to the interface"
          />
          <button type="submit">Update UI</button>
        </div>
      </form>
    );
  },
});

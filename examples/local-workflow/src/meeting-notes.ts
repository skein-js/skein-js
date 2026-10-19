export interface MeetingAction {
  owner: string;
  task: string;
  due: string;
}

export interface MeetingRecap {
  title: string;
  notes: string;
  summary?: string;
  application?: "meetings" | "reading";
  documentId?: string;
  questions?: string[];
  quotes?: string[];
  actions: MeetingAction[];
  decisions: string[];
  outcome: "review" | "approved" | "saved" | "dismissed";
  savedPath: string;
}

export const sampleMeeting = {
  title: "Website launch check-in",
  notes: `Website launch check-in\n\nMaya said the homepage copy needs one final pass. She'll share the finished version on Friday.\n\nSam will test the sign-up flow on mobile by Monday. We agreed to keep the first release focused on the homepage and sign-up flow, and move customer stories to the next release.\n\nAlex will send the launch checklist to the team tomorrow. We should check in again once the mobile testing is done.`,
};

/** Deterministic test fixture only; normal applications always use the selected model. */
export function draftMeeting(notes: string): Pick<MeetingRecap, "actions" | "decisions"> {
  if (notes === sampleMeeting.notes)
    return {
      decisions: [
        "Keep the first release focused on the homepage and sign-up flow.",
        "Move the customer stories page to the next release.",
      ],
      actions: [
        { owner: "Maya", task: "Share the final homepage copy", due: "Friday" },
        { owner: "Sam", task: "Test the sign-up flow on mobile", due: "Monday" },
        { owner: "Alex", task: "Send the launch checklist to the team", due: "Tomorrow" },
      ],
    };
  const actions: MeetingAction[] = [];
  const decisions: string[] = [];
  for (const line of notes.split(/\r?\n/)) {
    const trimmed = line.trim();
    const decision = /^Decision:\s*(.+)$/i.exec(trimmed);
    if (decision) {
      decisions.push(decision[1]!);
      continue;
    }
    const action = /^[-*]\s+(?:\[ \]\s*)?([^:|]+):\s*([^|]+)(?:\|\s*(.+))?$/.exec(trimmed);
    if (action)
      actions.push({
        owner: action[1]!.trim(),
        task: action[2]!.trim(),
        due: action[3]?.trim() ?? "Not set",
      });
  }
  return { actions, decisions };
}

export function meetingMarkdown(
  recap: Pick<
    MeetingRecap,
    "title" | "notes" | "actions" | "decisions" | "summary" | "application" | "questions" | "quotes"
  >,
): string {
  return [
    `# ${recap.title}`,
    "",
    ...(recap.summary ? [recap.summary, ""] : []),
    recap.application === "reading" ? "## Key ideas" : "## Decisions",
    "",
    ...(recap.decisions.length
      ? recap.decisions.map((decision) => `- ${decision}`)
      : ["No decisions recorded."]),
    "",
    recap.application === "reading" ? "## Questions to explore" : "## Follow-ups",
    "",
    ...(recap.application === "reading"
      ? (recap.questions?.map((question) => `- ${question}`) ?? [])
      : recap.actions.length
        ? recap.actions.map(({ owner, task, due }) => `- [ ] ${task} — ${owner} · ${due}`)
        : ["No follow-ups recorded."]),
    "",
    ...(recap.quotes?.length
      ? ["## Source excerpts", "", ...recap.quotes.map((quote) => `> ${quote}`), ""]
      : []),
    recap.application === "reading" ? "## Original document" : "## Original notes",
    "",
    recap.notes,
    "",
  ].join("\n");
}

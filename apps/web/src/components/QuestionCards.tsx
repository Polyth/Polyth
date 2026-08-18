import { useState } from "react";
import { answerQuestion, rejectQuestion } from "../init.ts";
import type { PendingQuestion } from "../reduce.ts";
import type { JsonObject } from "@polyth/contracts";

function questionLabel(item: JsonObject, index: number): string {
  const v = item.question;
  return typeof v === "string" && v !== "" ? v : `Question ${index + 1}`;
}

function QuestionCard({ q }: { q: PendingQuestion }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const submit = () => {
    const filled = Object.keys(answers).length === q.questions.length;
    if (!filled) return;
    void answerQuestion(q.requestId, answers as JsonObject);
  };
  return (
    <div className="question-card">
      <div className="q-title">Question from the agent</div>
      {q.questions.map((item, i) => (
        <div key={i}>
          <label style={{ color: "var(--muted)", fontSize: "12.5px" }}>{questionLabel(item, i)}</label>
          <input
            value={answers[String(i)] ?? ""}
            placeholder="Answer…"
            onChange={(e) => setAnswers((a) => ({ ...a, [String(i)]: e.target.value }))}
          />
        </div>
      ))}
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={submit} disabled={Object.keys(answers).length !== q.questions.length}>Submit</button>
        <button className="danger" onClick={() => void rejectQuestion(q.requestId)}>Reject</button>
      </div>
    </div>
  );
}

export default function QuestionCards({ questions }: { questions: PendingQuestion[] }) {
  if (questions.length === 0) return null;
  return (
    <div className="question-cards">
      {questions.map((q) => (
        <QuestionCard key={q.requestId} q={q} />
      ))}
    </div>
  );
}
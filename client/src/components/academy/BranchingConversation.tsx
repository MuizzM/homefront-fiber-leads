// ── Branching conversation ────────────────────────────────────────────────────
//
// An authored decision tree. Cheaper than the free-text role play and better at
// one specific job: proving that a single sentence decides where the whole
// conversation goes. A rep who takes the poor branch and reads what the
// customer says next has learned something no lesson paragraph delivers.
//
// The transcript accumulates on screen rather than replacing itself, because
// seeing your own three choices in a row is the review.

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { Chip, Panel, PrimaryButton, QuietButton } from "./primitives";
import { useActivityAutosave } from "@/lib/useAcademy";
import { getPersona } from "@shared/academyPersonas";
import { getBranchNode, type BranchOption, type BranchTree } from "@shared/academyPath";

type Step = { customer: string; chosen?: BranchOption };

export type BranchingState = { nodeId: string; path: string[] };

const QUALITY_TONE = { poor: "bad", okay: "warn", strong: "good" } as const;
const QUALITY_LABEL = { poor: "Weak choice", okay: "Workable", strong: "Strong choice" } as const;

export default function BranchingConversation({
  tree, activityId, resume, onComplete, onExit,
}: {
  tree: BranchTree;
  activityId: string;
  resume: BranchingState | null;
  onComplete: (score: number) => void;
  onExit: () => void;
}) {
  const persona = getPersona(tree.personaId);
  const [nodeId, setNodeId] = useState(resume?.nodeId ?? tree.startNodeId);
  const [chosen, setChosen] = useState<BranchOption[]>([]);

  useActivityAutosave(activityId, { nodeId, path: chosen.map((c) => c.next) }, true);

  const node = getBranchNode(tree, nodeId);
  const terminal = !!node?.outcome;

  const steps: Step[] = useMemo(() => {
    // Rebuild the visible transcript from the choices made this sitting. A
    // resumed session shows only the current node, which is honest: we stored
    // where they are, not a replay of how they got there.
    const out: Step[] = [];
    let cursor = getBranchNode(tree, resume?.nodeId ?? tree.startNodeId);
    for (const choice of chosen) {
      if (cursor) out.push({ customer: cursor.customer, chosen: choice });
      cursor = getBranchNode(tree, choice.next);
    }
    return out;
  }, [chosen, tree, resume?.nodeId]);

  // Score is the average quality of the choices made. Strong is 100, workable
  // is 65, weak is 25. A rep who takes one weak branch and recovers still ends
  // above the pass line, which is the right lesson: recovery counts.
  const score = useMemo(() => {
    if (!chosen.length) return 0;
    const values = chosen.map((c) => (c.quality === "strong" ? 100 : c.quality === "okay" ? 65 : 25));
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  }, [chosen]);

  function choose(option: BranchOption) {
    setChosen((prev) => [...prev, option]);
    setNodeId(option.next);
  }

  function restart() {
    setChosen([]);
    setNodeId(tree.startNodeId);
  }

  if (!node) {
    return (
      <Panel tone="warn">
        <p className="text-sm text-foreground">This conversation could not be loaded. Go back and open it again.</p>
        <div className="mt-3"><QuietButton onClick={onExit}>Back</QuietButton></div>
      </Panel>
    );
  }

  return (
    <div className="space-y-4" data-testid={`branching-${tree.id}`}>
      <Panel tone="accent">
        <SectionLabel className="text-primary">{persona?.label ?? "The door"}</SectionLabel>
        <p className="mt-1 text-[13px] leading-relaxed text-foreground">{tree.setup}</p>
      </Panel>

      {/* What has already happened this run. */}
      {steps.map((step, i) => (
        <div key={i} className="space-y-2" data-testid={`branching-step-${i}`}>
          <CustomerLine name={persona?.name ?? "Customer"} text={step.customer} />
          {step.chosen && (
            <div className="ml-6 space-y-1.5">
              <div className="rounded-2xl rounded-tr-sm border border-primary/25 bg-primary/[0.07] px-3.5 py-2.5">
                <p className="text-[13px] leading-relaxed text-foreground">{step.chosen.text}</p>
              </div>
              <div className="flex items-start gap-2">
                <Chip tone={QUALITY_TONE[step.chosen.quality]}>{QUALITY_LABEL[step.chosen.quality]}</Chip>
                <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">{step.chosen.why}</p>
              </div>
            </div>
          )}
        </div>
      ))}

      {/* Where they are now. */}
      <CustomerLine name={persona?.name ?? "Customer"} text={node.customer} highlight />

      {!terminal && node.options && (
        <div className="space-y-2" role="group" aria-label="What do you say">
          <SectionLabel>What do you say</SectionLabel>
          {node.options.map((option, oi) => (
            <button
              key={oi}
              type="button"
              onClick={() => choose(option)}
              data-testid={`branching-option-${oi}`}
              className={cn(
                "flex min-h-11 w-full items-start gap-3 rounded-xl border border-border bg-card px-3.5 py-3 text-left",
                "text-[13px] leading-relaxed text-foreground transition-colors hover:border-primary/40 hover:bg-secondary/50",
                FOCUS,
              )}
            >
              <span aria-hidden="true" className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full border border-border text-[10px] font-bold text-muted-foreground">
                {String.fromCharCode(65 + oi)}
              </span>
              <span className="min-w-0 flex-1">{option.text}</span>
            </button>
          ))}
        </div>
      )}

      {terminal && (
        <Panel
          tone={node.outcome === "advanced" ? "accent" : node.outcome === "lost" ? "warn" : "plain"}
          testId="branching-outcome"
        >
          <div className="flex items-center gap-2">
            <Chip tone={node.outcome === "advanced" ? "good" : node.outcome === "lost" ? "bad" : "neutral"}>
              {node.outcome === "advanced" ? "Moved forward" : node.outcome === "lost" ? "Door closed" : "Clean exit"}
            </Chip>
            <span className="text-sm font-semibold tabular-nums text-foreground">{score}%</span>
          </div>
          {node.note && <p className="mt-2 text-[13px] leading-relaxed text-foreground">{node.note}</p>}
          <div className="mt-4 flex flex-wrap gap-2">
            <PrimaryButton onClick={() => onComplete(score)} testId="branching-finish">Save and continue</PrimaryButton>
            <QuietButton onClick={restart} testId="branching-restart">Take the other branch</QuietButton>
            <QuietButton onClick={onExit} testId="branching-exit">Leave for now</QuietButton>
          </div>
        </Panel>
      )}
    </div>
  );
}

function CustomerLine({ name, text, highlight }: { name: string; text: string; highlight?: boolean }) {
  return (
    <div className={cn("max-w-[85%]", highlight && "hf-rise")}>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{name}</div>
      <div
        className={cn(
          "rounded-2xl rounded-tl-sm border px-3.5 py-2.5",
          highlight ? "border-border bg-secondary" : "border-border bg-secondary/50",
        )}
      >
        <p className="text-[13px] leading-relaxed text-foreground">{text}</p>
      </div>
    </div>
  );
}

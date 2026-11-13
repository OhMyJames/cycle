import type { Plan } from "@cycle/protocol";
import { MorphLoader } from "../loader/morph-loader.tsx";
import { Icon } from "./icons.tsx";

/**
 * A plan's steps, each with its mark: a ticked box when done, the loader of dots on the one in hand,
 * an empty box before. The loader runs only while a turn does, since it would never stop after.
 */
export function PlanSteps({ plan, live }: { plan: Plan; live: boolean }) {
  return (
    <ol className="plan-steps no-scrollbar">
      {plan.steps.map((step, index) => (
        <li
          key={index}
          data-status={step.status === "inProgress" && !live ? "pending" : step.status}
        >
          <span className="mark">
            {step.status === "completed" ? (
              <span className="box done">
                <Icon name="check" size={10} />
              </span>
            ) : step.status === "inProgress" && live ? (
              <MorphLoader state="executing" />
            ) : (
              <span className="box" />
            )}
          </span>
          <span className="grow">{step.step}</span>
        </li>
      ))}
    </ol>
  );
}

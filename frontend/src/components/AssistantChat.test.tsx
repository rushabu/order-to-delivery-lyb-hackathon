import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Answer, AssistantChat } from "./AssistantChat";
import { ApiError } from "../api/client";

const api = vi.hoisted(() => vi.fn());
vi.mock("../api/client", async (original) => ({ ...(await original<typeof import("../api/client")>()), api }));

function renderChat(role: "COORDINATOR" | "DRIVER" | "CUSTOMER" = "CUSTOMER") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AssistantChat role={role} />
    </QueryClientProvider>,
  );
}

const STATUS = { configured: true, provider: "Groq", model: "test-model" };

describe("AssistantChat", () => {
  beforeEach(() => api.mockReset());

  it("opens from the top bar, says it is AI, and offers questions for the role", async () => {
    api.mockResolvedValue(STATUS);
    renderChat("CUSTOMER");
    expect(screen.queryByRole("region", { name: "Assistant" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Ask the assistant" }));
    expect(screen.getByRole("region", { name: "Assistant" })).toBeInTheDocument();
    expect(screen.getByText(/AI answers from the shipments you can see/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Where is my order?" })).toBeInTheDocument();
    expect(await screen.findByText("Answers by Groq, model test-model")).toBeInTheDocument();
  });

  it("sends the question with the earlier turns and shows the answer", async () => {
    api.mockImplementation(async (path: string) => (path === "/assistant" ? STATUS : { answer: "It is due at 11:45 IST.", provider: "Groq", model: "test-model" }));
    renderChat("CUSTOMER");
    await userEvent.click(screen.getByRole("button", { name: "Ask the assistant" }));
    await userEvent.type(screen.getByLabelText("Your question"), "Where is SHP-1001?{Enter}");
    expect(await screen.findByText("It is due at 11:45 IST.")).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/assistant/ask", { method: "POST", body: { question: "Where is SHP-1001?", history: [] } });

    await userEvent.type(screen.getByLabelText("Your question"), "And why?");
    await userEvent.click(screen.getByRole("button", { name: "Send question" }));
    await waitFor(() =>
      expect(api).toHaveBeenLastCalledWith("/assistant/ask", {
        method: "POST",
        body: {
          question: "And why?",
          history: [
            { role: "user", content: "Where is SHP-1001?" },
            { role: "assistant", content: "It is due at 11:45 IST." },
          ],
        },
      }),
    );
  });

  it("shows a failure with a retry that does not repeat the question", async () => {
    let fail = true;
    api.mockImplementation(async (path: string) => {
      if (path === "/assistant") return STATUS;
      if (fail) throw new ApiError(502, "ASSISTANT_UNAVAILABLE", "The assistant could not answer just now. Try again in a moment");
      return { answer: "On the road, 40 km left.", provider: "Groq", model: "test-model" };
    });
    renderChat("DRIVER");
    await userEvent.click(screen.getByRole("button", { name: "Ask the assistant" }));
    await userEvent.click(screen.getByRole("button", { name: "What is my ETA?" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The assistant could not answer just now");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("On the road, 40 km left.")).toBeInTheDocument();
    expect(screen.getAllByText("What is my ETA?")).toHaveLength(1);
  });

  it("says so when the API has no key, and disables the box", async () => {
    api.mockResolvedValue({ ...STATUS, configured: false });
    renderChat("COORDINATOR");
    await userEvent.click(screen.getByRole("button", { name: "Ask the assistant" }));
    expect(await screen.findByText(/The assistant is switched off/)).toBeInTheDocument();
    expect(screen.getByLabelText("Your question")).toBeDisabled();
  });
});

describe("Answer", () => {
  it("shows the model's answer as a sentence, a list and a Next line, with bold ids", () => {
    const { container } = render(<Answer text={"You have 2 deliveries on the way.\n- **SHP-1001**: in transit, due **11:15 IST**\n- **SHP-1004**: planned\nNext: nothing to do."} />);
    expect(screen.getByText("You have 2 deliveries on the way.")).toBeInTheDocument();
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByText("SHP-1001").tagName).toBe("STRONG");
    expect(screen.getByText("nothing to do.").closest("p")).toHaveTextContent("Next: nothing to do.");
    expect(container.textContent).not.toContain("**");
  });
});

export type LastWindowCloseAction = "exit" | "quit" | "stay";

export const lastWindowCloseAction = (
  platform: NodeJS.Platform,
): LastWindowCloseAction => {
  if (platform === "win32") {
    return "exit";
  }
  if (platform === "darwin") {
    return "stay";
  }
  return "quit";
};

/** Caractères déjà reçus au-delà de la ligne précédente (saisie collée ou envoyée d'un bloc). */
let pending = "";

/** Saisie au clavier (mot de passe masqué si `hidden`) — jamais d'écho, jamais d'écriture sur disque. */
export function ask(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let value = "";
    if (hidden && stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (let index = 0; index < chunk.length; index += 1) {
        const char = chunk[index];
        if (char === "\r" || char === "\n") {
          pending = chunk.slice(index + 1).replace(/^\n/, "");
          stdin.removeListener("data", onData);
          if (hidden && stdin.isTTY) stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") process.exit(130);
        if (char === "\u007f") value = value.slice(0, -1);
        else value += char;
        // Terminal en mode ligne : il affiche déjà la saisie lui-même.
        if (!hidden && stdin.isTTY && stdin.isRaw) process.stdout.write(char);
      }
    };
    stdin.on("data", onData);
    if (pending) {
      const buffered = pending;
      pending = "";
      onData(buffered);
    }
  });
}

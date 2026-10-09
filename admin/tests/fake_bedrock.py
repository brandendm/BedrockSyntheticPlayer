"""A stand-in for bedrock_server: prints a start line, answers a few console commands the way the real one does."""
import sys
print("[INFO] Server started.", flush=True)
for line in sys.stdin:
    c = line.strip()
    if c == "stop":
        print("[INFO] Stopping server...", flush=True)
        break
    if c == "save hold":
        print("Saving...", flush=True)
    elif c == "save query":
        print("Data saved. Files are now ready to be copied.", flush=True)
        print("Bedrock level/db/a.ldb:5, Bedrock level/db/b.ldb:3", flush=True)
    elif c == "save resume":
        print("Changes to the world are resumed.", flush=True)
    elif c == "list":
        print("There are 0/10 players online:", flush=True)
    elif c.startswith("say "):
        print("[Server] " + c[4:], flush=True)
    else:
        print("Unknown command: " + c.split()[0], flush=True)

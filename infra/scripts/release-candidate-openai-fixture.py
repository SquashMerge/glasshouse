#!/usr/bin/env python3
"""Synthetic OpenAI endpoint for the isolated release-candidate GEPA probe."""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

SOURCE = "Summarize tasks"
CANDIDATE = "Summarize tasks accurately and answer the question."
counts = {"task_seed": 0, "task_candidate": 0, "reflection": 0, "rejected": 0}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def respond(self, status, data):
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.respond(200, counts) if self.path == "/stats" else self.respond(404, {})

    def do_POST(self):
        try:
            if self.path != "/v1/chat/completions" or self.headers.get("Authorization") != "Bearer synthetic-gepa-key":
                raise ValueError("unexpected request")
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 65536:
                raise ValueError("invalid request size")
            request = json.loads(self.rfile.read(size))
            messages = request["messages"]
            key = self.headers.get("Idempotency-Key", "")
            if ":reflection:" in key:
                counts["reflection"] += 1
                content = f"```\n{CANDIDATE}\n```"
            elif ":task:" in key:
                system = next(m["content"] for m in messages if m["role"] == "system")
                question = next(m["content"] for m in messages if m["role"] == "user")
                if system == SOURCE:
                    counts["task_seed"] += 1
                    content = "incorrect response"
                elif system == CANDIDATE and question in ("alpha question", "zulu question"):
                    counts["task_candidate"] += 1
                    content = "training response" if question == "alpha question" else "held out response"
                else:
                    raise ValueError("unexpected task")
            else:
                raise ValueError("unexpected dispatch role")
            self.respond(200, {"id": "chatcmpl-fixture", "object": "chat.completion", "created": 1, "model": request["model"], "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
        except (ValueError, KeyError, TypeError, StopIteration, json.JSONDecodeError):
            counts["rejected"] += 1
            self.respond(400, {"error": {"message": "invalid fixture request"}})


HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()

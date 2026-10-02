window.__ModuleLoader__.load({
	id: "@zhengjunyao/dsh-mcp-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/api.ts
		/** An API failure carrying the host's message. */
		var ManagerApiError = class extends Error {
			constructor(message) {
				super(message);
				this.name = "ManagerApiError";
			}
		};
		/** Parse a JSON response or throw. */
		async function readJson(response) {
			let body;
			try {
				body = await response.json();
			} catch {
				throw new ManagerApiError(`HTTP ${response.status}: invalid JSON response`);
			}
			if (!response.ok) throw new ManagerApiError(typeof body === "object" && body !== null && typeof body.error === "string" ? body.error : typeof body === "object" && body !== null && typeof body.message === "string" ? body.message : `HTTP ${response.status}`);
			return body;
		}
		/** Plain fetch helper with an error wrapper. */
		async function request(path, init) {
			let response;
			try {
				response = await fetch(path, init);
			} catch (error) {
				throw new ManagerApiError("Ошибка сети: " + String(error instanceof Error ? error.message : error));
			}
			return await readJson(response);
		}
		/** POST one JSON body to a route. */
		async function post(path, body = {}) {
			return await request(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body)
			});
		}
		/** The MCP manager panel API. */
		var ManagerApi = class {
			/** The full state (settings + servers + live runtime). */
			async state() {
				return await request("/api/dsh-mcp-manager/state");
			}
			/** Patch the plugin switches. */
			async setConfig(patch) {
				return await post("/api/dsh-mcp-manager/config", patch);
			}
			/** Add a server, or update `originalName` with `server`. */
			async saveServer(server, originalName) {
				return await post("/api/dsh-mcp-manager/server", originalName === void 0 ? { server } : {
					server,
					originalName
				});
			}
			/** Delete one server. */
			async removeServer(name) {
				return await post("/api/dsh-mcp-manager/server/remove", { name });
			}
			/** Enable or disable one server. */
			async toggleServer(name, enabled) {
				return await post("/api/dsh-mcp-manager/server/toggle", {
					name,
					enabled
				});
			}
			/** Reconnect one saved server, or try an unsaved draft. */
			async test(name, server) {
				return await post("/api/dsh-mcp-manager/test", server === void 0 ? { name } : {
					name,
					server
				});
			}
			/** Import definitions from another manager's file. */
			async importServers(path) {
				return await post("/api/dsh-mcp-manager/import", path === void 0 || path === "" ? {} : { path });
			}
			/** Re-read the state file and reconcile. */
			async reload() {
				return await post("/api/dsh-mcp-manager/reload");
			}
		};
		//#endregion
		//#region src/client/McpManagerPanel.tsx
		/**
		* MCP manager settings panel — rendered inside the web settings page
		* (settings.section entry).
		*
		* One screen: the configured servers with their live state, and a form that
		* adds or edits one. Two behaviours worth calling out:
		*
		*   - **Test before you save.** The form's «Тест» button posts the *draft*, so the
		*     host connects the definition without persisting it, reports the tools it
		*     offers, disconnects, and restores the previous live set. A typo is caught
		*     here rather than after a save.
		*   - **Deleting disconnects.** Removal is confirmed, then the host disposes the
		*     bridge instance, which is what unregisters those MCP tools.
		*
		* Plain React, inline styles only (no CSS pipeline, no theme coupling).
		*/
		/** Module-level API client (stateless; the component closes over it). */
		const api = new ManagerApi();
		/** One shared style sheet (kept tiny and theme-agnostic). */
		const s = {
			card: {
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				maxWidth: "880px",
				padding: "14px 16px",
				borderRadius: "10px",
				border: "1px solid rgba(128,128,128,0.3)",
				fontSize: "13px",
				color: "inherit"
			},
			row: {
				display: "flex",
				gap: "8px",
				alignItems: "center",
				flexWrap: "wrap"
			},
			label: {
				fontSize: "12px",
				opacity: .85,
				minWidth: "78px"
			},
			input: {
				flex: 1,
				minWidth: "200px",
				padding: "4px 6px",
				borderRadius: "6px",
				border: "1px solid rgba(128,128,128,0.35)",
				background: "rgba(128,128,128,0.08)",
				color: "inherit",
				fontSize: "12px"
			},
			textarea: {
				flex: 1,
				minWidth: "200px",
				minHeight: "54px",
				padding: "4px 6px",
				borderRadius: "6px",
				border: "1px solid rgba(128,128,128,0.35)",
				background: "rgba(128,128,128,0.08)",
				color: "inherit",
				fontSize: "12px",
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
			},
			button: {
				padding: "4px 10px",
				borderRadius: "6px",
				cursor: "pointer",
				border: "1px solid rgba(128,128,128,0.4)",
				background: "rgba(128,128,128,0.14)",
				color: "inherit",
				fontSize: "12px",
				whiteSpace: "nowrap"
			},
			buttonPrimary: {
				padding: "4px 12px",
				borderRadius: "6px",
				cursor: "pointer",
				border: "1px solid rgba(110,150,220,0.65)",
				background: "rgba(90,130,200,0.22)",
				color: "inherit",
				fontSize: "12px",
				fontWeight: 600,
				whiteSpace: "nowrap"
			},
			buttonDanger: {
				padding: "4px 10px",
				borderRadius: "6px",
				cursor: "pointer",
				border: "1px solid rgba(190,100,95,0.55)",
				background: "rgba(190,100,95,0.16)",
				color: "inherit",
				fontSize: "12px",
				whiteSpace: "nowrap"
			},
			buttonDisabled: {
				opacity: .45,
				cursor: "not-allowed"
			},
			server: {
				display: "flex",
				flexDirection: "column",
				gap: "5px",
				padding: "9px 11px",
				borderRadius: "8px",
				border: "1px solid rgba(128,128,128,0.25)",
				background: "rgba(128,128,128,0.05)"
			},
			mono: {
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
				fontSize: "11px",
				opacity: .85,
				wordBreak: "break-all"
			},
			ok: {
				fontSize: "12px",
				color: "#3d8b5f"
			},
			err: {
				fontSize: "12px",
				color: "#c0504d",
				whiteSpace: "pre-wrap"
			},
			warn: {
				fontSize: "12px",
				color: "#c9763a"
			},
			muted: {
				fontSize: "11px",
				opacity: .65
			},
			badge: {
				fontSize: "10px",
				padding: "1px 6px",
				borderRadius: "999px",
				border: "1px solid rgba(128,128,128,0.4)",
				opacity: .9,
				whiteSpace: "nowrap"
			}
		};
		/** The phase badge colour and glyph. */
		function phaseBadge(phase) {
			switch (phase) {
				case "active": return {
					text: "● Подключено",
					color: "#3d8b5f"
				};
				case "waiting": return {
					text: "◌ Нет инструментов",
					color: "#c9763a"
				};
				case "starting": return {
					text: "◌ Подключение…",
					color: "#c9763a"
				};
				case "error": return {
					text: "✖ Ошибка",
					color: "#c0504d"
				};
				default: return {
					text: "○ Не подключён",
					color: "rgba(128,128,128,0.9)"
				};
			}
		}
		/** Split a textarea into trimmed, non-empty lines. */
		function linesOf(value) {
			return value.split("\n").map((line) => line.trim()).filter((line) => line !== "");
		}
		/** Parse `KEY=VALUE` / `KEY: VALUE` lines into a dictionary. */
		function dictOf(value) {
			const out = {};
			for (const line of linesOf(value)) {
				const match = /^([^=:]+)\s*[=:]\s*(.*)$/.exec(line);
				if (match === null) continue;
				const key = match[1].trim();
				if (key !== "") out[key] = match[2];
			}
			return out;
		}
		/** Render a dictionary back into `KEY=VALUE` lines. */
		function dictText(value) {
			if (value === void 0) return "";
			return Object.entries(value).map(([key, item]) => `${key}=${item}`).join("\n");
		}
		/** Build the form state for a new server. */
		function blankForm() {
			return {
				originalName: "",
				name: "",
				transport: "stdio",
				enabled: true,
				description: "",
				command: "",
				argsText: "",
				envText: "",
				cwd: "",
				url: "",
				headersText: "",
				timeoutText: "60000"
			};
		}
		/** Build the form state for an existing server. */
		function formOf(server) {
			return {
				originalName: server.name,
				name: server.name,
				transport: server.transport,
				enabled: server.enabled,
				description: server.description,
				command: server.command,
				argsText: server.args.join("\n"),
				envText: dictText(server.env),
				cwd: server.cwd,
				url: server.url,
				headersText: dictText(server.headers),
				timeoutText: String(server.toolCallTimeoutMs)
			};
		}
		/** Project the form onto the payload the host accepts. */
		function payloadOf(form) {
			const timeout = Number(form.timeoutText);
			return {
				name: form.name.trim(),
				transport: form.transport,
				enabled: form.enabled,
				description: form.description,
				command: form.transport === "stdio" ? form.command.trim() : "",
				args: form.transport === "stdio" ? linesOf(form.argsText) : [],
				env: form.transport === "stdio" ? dictOf(form.envText) : {},
				cwd: form.transport === "stdio" ? form.cwd.trim() : "",
				url: form.transport === "streamable-http" ? form.url.trim() : "",
				headers: form.transport === "streamable-http" ? dictOf(form.headersText) : {},
				toolCallTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : 6e4
			};
		}
		/**
		* The MCP manager settings card.
		* @returns the rendered panel.
		*/
		function McpManagerPanel() {
			const [state, setState] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)("");
			const [notice, setNotice] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)("");
			const [form, setForm] = (0, react.useState)(null);
			const [expanded, setExpanded] = (0, react.useState)("");
			const refresh = (0, react.useCallback)(async () => {
				try {
					setState(await api.state());
					setError("");
				} catch (failure) {
					setError(failure instanceof ManagerApiError ? failure.message : String(failure));
				}
			}, []);
			(0, react.useEffect)(() => {
				refresh();
			}, [refresh]);
			/** Run one mutating action with shared busy/notice plumbing. */
			const act = (0, react.useCallback)(async (key, task) => {
				setBusy(key);
				setNotice("");
				try {
					const result = await task();
					setNotice(result.message);
					await refresh();
				} catch (failure) {
					setError(failure instanceof ManagerApiError ? failure.message : String(failure));
				} finally {
					setBusy("");
				}
			}, [refresh]);
			const runtimeOf = (0, react.useCallback)((name) => state?.runtime.find((view) => view.name === name), [state]);
			const totals = (0, react.useMemo)(() => {
				const views = state?.runtime ?? [];
				return {
					servers: state?.servers.length ?? 0,
					active: views.filter((view) => view.phase === "active").length,
					tools: views.reduce((sum, view) => sum + view.toolCount, 0),
					broken: views.filter((view) => view.phase === "error").length
				};
			}, [state]);
			const update = (patch) => {
				setForm((current) => current === null ? current : {
					...current,
					...patch
				});
			};
			const config = state?.config ?? {
				enabled: true,
				announceToAgent: true
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: s.card,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.row,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
								style: { fontSize: "14px" },
								children: "Управление MCP"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: s.muted,
								children: [
									"Серверы: ",
									totals.servers,
									" · Подключено: ",
									totals.active,
									" · Инструменты MCP: ",
									totals.tools,
									totals.broken > 0 ? ` · Ошибки: ${totals.broken}` : ""
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: {
									...s.button,
									...busy === "plugin" ? s.buttonDisabled : {}
								},
								disabled: busy !== "",
								onClick: () => {
									act("plugin", async () => await api.setConfig({ enabled: !config.enabled }));
								},
								children: config.enabled ? "Отключить плагин" : "Включить плагин"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.muted,
						children: [
							"Поддерживаются stdio и Streamable HTTP; подключение и отключение выполняются в рантайме, без перезапуска DSH. Инструменты сервера появляются в сессии как ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "mcp__<имя_сервера>__<имя_инструмента>" }),
							"."
						]
					}),
					state?.bridgeError != null && state.bridgeError !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.err,
						children: ["Не найден встроенный в harness MCP-мост (@deepseek-ai/dsh-mcp-client): ", state.bridgeError]
					}),
					state !== null && state.bridge !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.muted,
						children: [
							"MCP-мост: ",
							state.bridge.source,
							" (",
							state.bridge.via,
							")"
						]
					}),
					state !== null && state.dropped > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.warn,
						children: [
							"В файле конфигурации есть ",
							state.dropped,
							" записей, которые не распознаны или имеют дублирующиеся имена — они пропущены."
						]
					}),
					error !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: s.err,
						children: error
					}),
					notice !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: s.ok,
						children: notice
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: "7px"
						},
						children: [(state?.servers ?? []).length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: s.muted,
							children: "MCP-серверы ещё не настроены. Нажмите «Добавить сервер» ниже, чтобы начать."
						}), (state?.servers ?? []).map((server) => {
							const view = runtimeOf(server.name);
							const badge = phaseBadge(view?.phase ?? "stopped");
							const open = expanded === server.name;
							const target = server.transport === "stdio" ? `${server.command} ${server.args.join(" ")}`.trim() || "(command не указан)" : server.url || "(url не указана)";
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: s.server,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: s.row,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: {
													...s.badge,
													color: badge.color,
													borderColor: badge.color
												},
												children: badge.text
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
												style: { fontSize: "13px" },
												children: server.name
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: s.badge,
												children: server.transport
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												style: s.muted,
												children: ["Инструменты: ", view?.toolCount ?? 0]
											}),
											!server.enabled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: s.muted,
												children: "(отключён)"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												style: {
													...s.button,
													...busy !== "" ? s.buttonDisabled : {}
												},
												disabled: busy !== "",
												onClick: () => {
													act(`test:${server.name}`, async () => await api.test(server.name));
												},
												children: "Тест"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												style: {
													...s.button,
													...busy !== "" ? s.buttonDisabled : {}
												},
												disabled: busy !== "",
												onClick: () => {
													act(`toggle:${server.name}`, async () => await api.toggleServer(server.name, !server.enabled));
												},
												children: server.enabled ? "Отключить" : "Включить"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												style: {
													...s.button,
													...busy !== "" ? s.buttonDisabled : {}
												},
												disabled: busy !== "",
												onClick: () => {
													setForm(formOf(server));
													setNotice("");
												},
												children: "Изменить"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												style: {
													...s.buttonDanger,
													...busy !== "" ? s.buttonDisabled : {}
												},
												disabled: busy !== "",
												onClick: () => {
													if (!window.confirm(`Точно удалить сервер «${server.name}»? Его MCP-инструменты будут сняты с регистрации.`)) return;
													act(`remove:${server.name}`, async () => await api.removeServer(server.name));
												},
												children: "Удалить"
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: s.mono,
										children: target
									}),
									server.description !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: s.muted,
										children: server.description
									}),
									view?.error != null && view.error !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: s.err,
										children: view.error
									}),
									(view?.tools.length ?? 0) > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: {
											...s.button,
											padding: "1px 7px",
											fontSize: "11px"
										},
										onClick: () => setExpanded(open ? "" : server.name),
										children: open ? "Свернуть список инструментов" : `Показать инструменты (${view?.toolCount ?? 0})`
									}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											...s.mono,
											marginTop: "4px"
										},
										children: (view?.tools ?? []).join(", ")
									})] })
								]
							}, server.name);
						})]
					}),
					form === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.row,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: s.buttonPrimary,
								onClick: () => {
									setForm(blankForm());
									setNotice("");
								},
								children: "Добавить сервер"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: {
									...s.button,
									...busy !== "" ? s.buttonDisabled : {}
								},
								disabled: busy !== "",
								onClick: () => {
									act("reload", async () => {
										const result = await api.reload();
										return {
											ok: result.ok,
											message: result.message
										};
									});
								},
								children: "Перечитать конфигурацию"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: {
									...s.button,
									...busy !== "" ? s.buttonDisabled : {}
								},
								disabled: busy !== "",
								onClick: () => {
									act("import", async () => {
										const result = await api.importServers();
										return {
											ok: result.ok,
											message: result.message
										};
									});
								},
								children: "Импортировать из старого менеджера"
							})
						]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...s.server,
							borderColor: "rgba(110,150,220,0.5)"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
								style: { fontSize: "13px" },
								children: form.originalName === "" ? "Добавить сервер" : `Редактирование «${form.originalName}»`
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: s.row,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: s.label,
									children: "Имя"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: s.input,
									value: form.name,
									placeholder: "garmin (станет пространством имён mcp__garmin__*)",
									onChange: (event) => update({ name: event.target.value })
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: s.row,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: s.label,
										children: "Транспорт"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										style: s.input,
										value: form.transport,
										onChange: (event) => update({ transport: event.target.value }),
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "stdio",
											children: "stdio (локальный процесс)"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "streamable-http",
											children: "streamable-http (удалённый URL)"
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										style: {
											...s.muted,
											display: "flex",
											gap: "4px",
											alignItems: "center"
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: form.enabled,
											onChange: (event) => update({ enabled: event.target.checked })
										}), "Включить после сохранения"]
									})
								]
							}),
							form.transport === "stdio" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: s.row,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: s.label,
										children: "Команда"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										style: s.input,
										value: form.command,
										placeholder: "/opt/homebrew/bin/uvx",
										onChange: (event) => update({ command: event.target.value })
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: s.row,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: s.label,
										children: "Аргументы"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
										style: s.textarea,
										value: form.argsText,
										placeholder: "по одному аргументу на строку:\ngarmin-mcp",
										onChange: (event) => update({ argsText: event.target.value })
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: s.row,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: s.label,
										children: "Переменные окружения"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
										style: s.textarea,
										value: form.envText,
										placeholder: "строки KEY=VALUE (можно оставить пустым)",
										onChange: (event) => update({ envText: event.target.value })
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: s.row,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: s.label,
										children: "Рабочая директория"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										style: s.input,
										value: form.cwd,
										placeholder: "(необязательно)",
										onChange: (event) => update({ cwd: event.target.value })
									})]
								})
							] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: s.row,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: s.label,
									children: "URL"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: s.input,
									value: form.url,
									placeholder: "https://example.com/mcp",
									onChange: (event) => update({ url: event.target.value })
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: s.row,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: s.label,
									children: "Заголовки"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									style: s.textarea,
									value: form.headersText,
									placeholder: "строки KEY=VALUE, например:\nAuthorization=Bearer xxx",
									onChange: (event) => update({ headersText: event.target.value })
								})]
							})] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: s.row,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: s.label,
										children: "Таймаут вызова"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										style: {
											...s.input,
											maxWidth: "120px"
										},
										value: form.timeoutText,
										onChange: (event) => update({ timeoutText: event.target.value })
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: s.muted,
										children: "мс (по умолчанию 60000)"
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: s.row,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: s.label,
									children: "Заметка"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: s.input,
									value: form.description,
									placeholder: "только для отображения, в настройки подключения не входит",
									onChange: (event) => update({ description: event.target.value })
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: s.row,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: {
											...s.button,
											...busy !== "" ? s.buttonDisabled : {}
										},
										disabled: busy !== "",
										onClick: () => {
											act("draft-test", async () => await api.test(form.name.trim(), payloadOf(form)));
										},
										children: "Проверить соединение (без сохранения)"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: {
											...s.buttonPrimary,
											...busy !== "" ? s.buttonDisabled : {}
										},
										disabled: busy !== "",
										onClick: () => {
											act("save", async () => {
												const result = await api.saveServer(payloadOf(form), form.originalName === "" ? void 0 : form.originalName);
												if (result.ok) setForm(null);
												return {
													ok: result.ok,
													message: result.message
												};
											});
										},
										children: "Сохранить"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: s.button,
										onClick: () => setForm(null),
										children: "Отмена"
									})
								]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.muted,
						children: [
							"Файл состояния: ",
							state?.file ?? "(неизвестно)",
							(state?.legacyCandidates ?? []).length > 0 ? " · при импорте будут опробованы старые расположения (mcp-servers.json и т. д.)" : ""
						]
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** Required services. */
		const inject = ["slots"];
		/**
		* Register the MCP manager settings card.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			try {
				ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "mcp-manager",
					order: 341,
					label: () => "Управление MCP"
				}, McpManagerPanel));
			} catch (error) {
				console.warn("[dsh-mcp-manager] settings panel registration failed:", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
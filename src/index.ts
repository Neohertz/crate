/**
 * @rbxts/crate
 *
 * The small, yet powerful state manager for roblox-ts.
 */

import Sift from "@rbxts/sift";

type ValueOrMutator<T> = { [K in keyof T]?: T[K] | ((v: T[K]) => T[K]) };

interface ExplodedPromise {
	method: () => Promise<unknown>;
	resolve: (v: unknown) => void;
	reject: (e: string) => void;
}

export class Crate<T extends object> {
	private state: T;
	private events: Set<RBXScriptConnection>;
	private updateBind: BindableEvent<(data: T) => void>;
	private keyUpdateBind: BindableEvent<(key: keyof T, value: T[keyof T]) => void>;
	private middlewareMethods: Map<string, Callback>;
	private enabled: boolean;

	// Queue
	private queue: Array<ExplodedPromise>;
	private queueInProgress: boolean;

	constructor(state: T) {
		this.enabled = true;

		this.queue = new Array();
		this.queueInProgress = false;

		this.middlewareMethods = new Map();

		this.keyUpdateBind = new Instance("BindableEvent", script);
		this.updateBind = new Instance("BindableEvent", script);

		this.events = new Set();
		this.state = state;
	}

	//// PUBLIC API ////

	/**
	 * Apply middleware to the crate, mutating keys before final
	 * `oldValue` is the value prior to the `set` method.
	 * `newValue` is the expected value to be set.
	 *
	 * @param key
	 * @param middleware
	 */
	useMiddleware<K extends keyof T>(key: K, middleware: (oldValue: T[K], newValue: T[K]) => T[K]) {
		this.middlewareMethods.set(key as string, middleware);
	}

	/**
	 * Update the crate state with a partial object.
	 *
	 * `update` also takes in a second parameter that, when true, will deep clone the passed object. [See Issue #1](https://github.com/Neohertz/crate/issues/1)
	 *
	 * All update calls are queued internally.
	 *
	 * ```ts
	 * // set
	 * crate.update({
	 * 	coins: 10
	 * })
	 * // or increment/mutate
	 * crate.update({
	 * 	coins: (v) => v + 10
	 * })
	 * ```
	 *
	 * @param data Partial<VorM<T>>
	 * @param copy boolean
	 * @returns
	 */
	async update(data: Partial<ValueOrMutator<T>>, copy = false) {
		assert(this.enabled, "[Crate] Attempted to update crate state after calling cleanup().");

		// Deep clone the table only if the copy parameter is true.
		if (copy) data = Sift.Dictionary.copyDeep(data);

		return this.enqueue(async () => {
			let changed = false;

			for (const [k, v] of Sift.Dictionary.entries(data)) {
				let isMutator = false;

				// Check for mutator function
				if (typeIs(v, "function")) {
					data[k] = v(this.state[k]);
					isMutator = true;
				}

				if (this.middlewareMethods.has(k as string)) {
					// Check for middleware
					// HACK: we need to cast data[k] even though it will always be a value
					data[k] = this.executeMiddleware(k, this.state[k], data[k] as T[keyof T]);
				}

				// Only update on state change or mutator usage.
				if (data[k] === this.state[k] && !isMutator) continue;

				// Update for each key.
				changed = true;
				this.keyUpdateBind.Fire(k, data[k] as T[keyof T]);
			}

			this.state = { ...this.state, ...data };

			if (changed) {
				this.updateBind.Fire(this.state);
			}
		});
	}

	/**
	 * Listen for changes on a specific key.
	 */
	onUpdate<U extends keyof T>(key: U, callback: (state: T[U]) => void): RBXScriptConnection;
	/**
	 * Listen for changes on the entire crate.
	 */
	onUpdate(callback: (state: Readonly<T>) => void): RBXScriptConnection;
	onUpdate(key: unknown, callback?: unknown): RBXScriptConnection {
		let event;

		if (callback !== undefined) {
			const call = callback as (state: T[keyof T] | T) => void;
			event = this.keyUpdateBind.Event.Connect((k, v) => {
				if (k === key) {
					call(v as T[keyof T]);
				}
			});
		} else {
			const call = key as (state: T[keyof T] | T) => void;
			event = this.updateBind.Event.Connect((state) => call(state));
		}

		this.events.add(event);
		return event;
	}

	/**
	 * Get a frozen reference to the crate's internal state.
	 */
	get(): Readonly<T>;
	/**
	 * Get the value of a specific key in the crate's state.
	 * @param key
	 */
	get<K extends keyof T>(key: K): T[K];
	get(key?: keyof T) {
		assert(this.enabled, "[Crate] Attempted to fetch crate state after calling cleanup().");

		if (key !== undefined) {
			return this.state[key];
		} else {
			return table.freeze(Sift.Dictionary.copyDeep(this.state));
		}
	}

	/**
	 * Cleanup the crate's internal connections.
	 *
	 * Calling this method will cause future `update()` calls to error.
	 */
	cleanup() {
		this.enabled = false;
		this.events.forEach((v) => v?.Disconnect());
		this.updateBind.Destroy();
		this.keyUpdateBind.Destroy();
	}

	//// PRIVATE API ////

	/**
	 * Execute middleware with tests.
	 * @param key
	 * @param oldValue
	 * @param newValue
	 * @returns
	 */
	private executeMiddleware(key: keyof T, oldValue: T[keyof T], newValue: T[keyof T]): T[keyof T] {
		const MW_EXEC_TIME = tick();

		const Method = this.middlewareMethods.get(key as string) as Callback;
		const Result = Method !== undefined ? Method(oldValue, newValue) : newValue;

		if (tick() - MW_EXEC_TIME > 0.2)
			warn("[Crate] Yielding is prohibited within middleware to prevent unexpected behavior.");

		return Result;
	}

	/**
	 * Recursive method to step the internal function queue.
	 * @param recurse
	 * @returns
	 */
	private stepQueue(recurse = false) {
		if (this.queueInProgress && !recurse) {
			return;
		}

		this.queueInProgress = true;

		if (this.queue.size() > 0) {
			const { method, resolve, reject } = this.queue.shift()!;

			method()
				.then((result) => resolve(result))
				.catch((reason) => reject(reason))
				.finally(() => this.stepQueue(true));
		} else {
			this.queueInProgress = false;
		}
	}

	/**
	 * Internal wrapper for enqueuing async functions.
	 * @param cb
	 * @returns
	 */
	private async enqueue<T>(cb: () => Promise<T>): Promise<T> {
		return new Promise((res, rej) => {
			this.queue.push({
				method: cb,
				resolve: res as (v: unknown) => void,
				reject: rej,
			});

			this.stepQueue();
		});
	}
}

export interface ExtensionStatusItem {
	/** Stable internal identity used to preserve selection across refreshes. */
	id: string;
	/** User-facing single-line status text. */
	text: string;
	/** Open the selected status item. */
	onSelect(): void | Promise<void>;
}

export interface InteractiveExtensionStatusView {
	item: ExtensionStatusItem;
	index: number;
	total: number;
	navigating: boolean;
}

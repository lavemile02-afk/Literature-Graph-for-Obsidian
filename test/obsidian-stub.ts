// A stand-in for the "obsidian" module, which exists only inside the app.
// Only what the tested modules touch when they load is defined.
export class Events {}
export class TAbstractFile {}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}
export class MarkdownView {}
export class Notice {}
export class Keymap {}
export class ItemView {}
export class Modal {}
export class PluginSettingTab {}
export class Plugin {}
export class Setting {}
export const requestUrl = () => Promise.reject(new Error('No network in tests'));
export const debounce = <T extends unknown[]>(fn: (...args: T) => unknown) => fn;
export const getAllTags = () => [];
export const setIcon = () => undefined;

/** @babel */
import generateConfig from './commands/generate';
import showState from './commands/show';
import fixFile from './commands/fix';

const importLazy = require('import-lazy').proxy(require);

const atm = importLazy('atom');

const checklist = importLazy('./lib/checklist');
const wrapGuideInterceptor = importLazy('./lib/wrapguide-interceptor');
const statusTile = importLazy('./lib/statustile-view');
const editorconfig = importLazy('editorconfig');

// Sets the state of the embedded editorconfig
// This includes the severity (info, warning..) as well as the notification-messages for users
function setState(ecfg) {
	checklist(ecfg);
	statusTile.updateIcon(ecfg.state);
}

// Initializes the (into the TextBuffer-instance) embedded editorconfig-object
function initializeTextBuffer(buffer) {
	if ('editorconfig' in buffer === false) {
		buffer.editorconfig = {
			buffer, // Preserving a reference to the parent `TextBuffer`
			disposables: new (atm.CompositeDisposable)(),
			state: 'subtle',
			settings: {
				/* eslint-disable camelcase */
				trim_trailing_whitespace: 'unset',
				insert_final_newline: 'unset',
				max_line_length: 'unset',
				end_of_line: 'unset',
				indent_style: 'unset',
				tab_width: 'unset',
				charset: 'unset'
				/* eslint-enable camelcase */
			},

			// Get the current Editor for this.buffer
			getCurrentEditor() {
				return atom.workspace.getTextEditors().reduce((prev, curr) => {
					return (curr.getBuffer() === this.buffer && curr) || prev;
				}, undefined);
			},

			// Applies the settings to the buffer and the corresponding editor
			applySettings() {
				const editor = this.getCurrentEditor();
				if (!editor) {
					return;
				}

				const configOptions = {scope: editor.getRootScopeDescriptor()};
				const settings = this.settings;

				if (editor && editor.getBuffer() === buffer) {
					if (settings.indent_style === 'unset') {
						const usesSoftTabs = editor.usesSoftTabs();
						if (usesSoftTabs === undefined) {
							editor.setSoftTabs(atom.config.get('editor.softTabs', configOptions));
						} else {
							editor.setSoftTabs(usesSoftTabs);
						}
					} else {
						editor.setSoftTabs(settings.indent_style === 'space');
					}

					if (settings.tab_width === 'unset') {
						editor.setTabLength(atom.config.get('editor.tabLength', configOptions));
					} else {
						editor.setTabLength(settings.tab_width);
					}

					if (settings.charset === 'unset') {
						buffer.setEncoding(atom.config.get('core.fileEncoding', configOptions));
					} else {
						buffer.setEncoding(settings.charset);
					}

					// Max_line_length-settings
					const editorParams = {};
					if (settings.max_line_length === 'unset') {
						editorParams.preferredLineLength =
							atom.config.get('editor.preferredLineLength', configOptions);
					} else {
						editorParams.preferredLineLength = settings.max_line_length;
					}

					// Update the editor-properties
					editor.update(editorParams);

					// Ensure the wrap-guide is being intercepted
					const bufferDom = atom.views.getView(editor);
					const wrapGuide = bufferDom.querySelector('* /deep/ .wrap-guide');
					if (wrapGuide !== null) {
						if (wrapGuide.editorconfig === undefined) {
							wrapGuide.editorconfig = this;
							wrapGuide.getNativeGuideColumn = wrapGuide.getGuideColumn;
							wrapGuide.getGuideColumn = wrapGuideInterceptor
																	.getGuideColumn
																	.bind(wrapGuide);
							wrapGuide.getNativeGuidesColumns = wrapGuide.getGuidesColumns;
							wrapGuide.getGuidesColumns = wrapGuideInterceptor
																	.getGuidesColumns
																	.bind(wrapGuide);
						}
						wrapGuide.updateGuide();
					}

					if (settings.end_of_line !== 'unset') {
						buffer.setPreferredLineEnding(settings.end_of_line);
					}
				}
				setState(this);
			},

			// `onWillSave` event handler
			// Trims whitespaces and inserts/strips final newline before saving
			onWillSave() {
				const settings = this.settings;

				if (settings.trim_trailing_whitespace === true) {
					buffer.backwardsScan(/[ \t]+$/gm, params => {
						if (params.match[0].length > 0) {
							params.replace('');
						}
					});
				}

				if (settings.insert_final_newline !== 'unset') {
					const lastRow = buffer.getLineCount() - 1;

					if (buffer.isRowBlank(lastRow)) {
						let stripStart = buffer.previousNonBlankRow(lastRow);

						if (settings.insert_final_newline === true) {
							stripStart += 1;
						}

						// Strip empty lines from the end
						if (stripStart < lastRow) {
							buffer.deleteRows(stripStart + 1, lastRow);
						}
					} else if (settings.insert_final_newline === true) {
						buffer.append('\n');
					}
				}
			}
		};

		buffer.editorconfig.disposables.add(
			buffer.onWillSave(buffer.editorconfig.onWillSave.bind(buffer.editorconfig))
		);

		if (buffer.getUri() && buffer.getUri().match(/[\\|/]\.editorconfig$/g) !== null) {
			buffer.editorconfig.disposables.add(
				buffer.onDidSave(reapplyEditorconfig)
			);
		}
	}
}

// Reveal and apply the editorconfig for the given TextEditor-instance
function observeTextEditor(editor) {
	if (!editor) {
		return;
	}

	initializeTextBuffer(editor.getBuffer());

	const file = editor.getURI();
	if (!file) {
		editor.onDidSave(() => {
			observeTextEditor(editor);
		});
		return;
	}

	editorconfig.parse(file).then(config => {
		if (Object.keys(config).length === 0) {
			return;
		}

		const ecfg = editor.getBuffer().editorconfig;
		const settings = ecfg.settings;
		const lineEndings = {
			crlf: '\r\n',
			cr: '\r',
			lf: '\n'
		};

		// Preserve evaluated Editorconfig
		ecfg.config = config;

		/* eslint-disable camelcase */

		// Carefully normalize and initialize config-settings
		settings.trim_trailing_whitespace = ('trim_trailing_whitespace' in config) &&
			typeof config.trim_trailing_whitespace === 'boolean' ?
			config.trim_trailing_whitespace === true :
			'unset';

		settings.insert_final_newline = ('insert_final_newline' in config) &&
			typeof config.insert_final_newline === 'boolean' ?
			config.insert_final_newline === true :
			'unset';

		settings.indent_style = (('indent_style' in config) &&
			config.indent_style.search(/^(space|tab)$/) > -1) ?
			config.indent_style :
			'unset';

		settings.end_of_line = lineEndings[config.end_of_line] || 'unset';

		settings.tab_width = parseInt(config.indent_size || config.tab_width, 10);
		if (isNaN(settings.tab_width) || settings.tab_width <= 0) {
			settings.tab_width = 'unset';
		}

		settings.max_line_length = parseInt(config.max_line_length, 10);
		if (isNaN(settings.max_line_length) || settings.max_line_length <= 0) {
			settings.max_line_length = 'unset';
		}

		settings.charset = ('charset' in config) ?
			config.charset.replace(/-/g, '').toLowerCase() :
			'unset';

		/* eslint-enable camelcase */

		ecfg.applySettings();
	}).catch(Error, e => {
		console.warn(`atom-editorconfig: ${e}`);
	});
}

// Reapplies the whole editorconfig to **all** open TextEditor-instances
function reapplyEditorconfig() {
	const textEditors = atom.workspace.getTextEditors();
	textEditors.forEach(editor => {
		observeTextEditor(editor);
	});
}

// Reapplies the settings immediately after changing the focus to a new pane
function observeActivePaneItem(editor) {
	if (editor && editor.constructor.name === 'TextEditor') {
		if (editor.buffer && editor.buffer.editorconfig) {
			editor.buffer.editorconfig.applySettings();
		}
	} else {
		statusTile.removeIcon();
	}
}

// Hook into the events to recognize the user opening new editors or changing the pane
const activate = () => {
	generateConfig();
	showState();
	fixFile();
	atom.workspace.observeTextEditors(observeTextEditor);
	atom.workspace.observeActivePaneItem(observeActivePaneItem);
	reapplyEditorconfig();
};

// Clean the status-icon up, remove all embedded editorconfig-objects
const deactivate = () => {
	const textEditors = atom.workspace.getTextEditors();
	textEditors.forEach(editor => {
		editor.getBuffer().editorconfig.disposables.dispose();
	});
	statusTile.removeIcon();
};

// Apply the statusbar icon-container
// The icon will be applied if needed
const consumeStatusBar = statusBar => {
	if (statusTile.containerExists() === false) {
		statusBar.addRightTile({
			item: statusTile.createContainer(),
			priority: 999
		});
	}
};

export default {activate, deactivate, consumeStatusBar};

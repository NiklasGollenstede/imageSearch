'use strict';

/**
 * @description Adds a context menu option 'Google Search for (background) image' to the page context.
 * Mouse-wheel-clicking or clicking while pressing 'Ctrl' will open the Google Images reverse search with the selected image in a new tab.
 * Left clicking or invoking the option otherwise opens the search in the current tab.
 * Works with linked/online, local, firefox-internal and inline images.
 */

const { Cu, } = require("chrome");
const { viewFor } = require("sdk/view/core");
const Windows = require("sdk/windows").browserWindows;
const { prefs: Prefs, } = require("sdk/simple-prefs");
const { Item, Menu, PageContext, } = require("sdk/context-menu");
const Tabs = require("sdk/tabs");
const File = require("sdk/io/file");
const { OS, } = Cu.import("resource://gre/modules/osfile.jsm", {});
Cu.importGlobalProperties([ 'btoa', ]); /* global btoa */
const toBase64 = btoa;

const {
	concurrent: { async, },
	/* global createElement */
	network: { HttpRequest, mimeTypes, arrayBufferToString, },
	functional: { noop, Logger, log, },
} = require('es6lib');
const runInTab = require('es6lib/runInTab');

const SCRIPT = 'contentScript';
const labels = {
	init: 'fkhlgnmxfdkgnsdyjknfksdlfnkljfdybgaewkljtngxcjkbn',
	base: 'No image found',
	image: 'Google Search for this image',
	hidden: 'Google Search for the image behind this element',
	background: 'Google Search for background image',
};


let menu; // global ContextMenu instance

function ContextMenu() {
	this.onMessage = this.onMessage.bind(this);
	this.onClick = this.onClick.bind(this);
	this.item = new Item(this);
}
Object.assign(ContextMenu.prototype, {
	_label: labels.init,
	image: 'https://www.google.com/images/icons/product/images-32.gif',

	set label(value) { this._label = this.item.value = value; },
	get label() { return this._label; },

	/**
	 * Forwards invoke events.
	 * @note '[SCRIPT]:' is used instead of 'contentScript:' to pass the static analysis of Mozilla's automated signing.
	 */
	[SCRIPT]: '('+ ((image, background) => {
		self.on('context', node => true);
		self.on('click', () => self.postMessage('invoke'));
	}) +')()',

	/**
	 * Called when the context menu is opened on { x, y, }. Asynchronously sets the type and url of the target image (if any) to this
	 * and sets the element text a appropriate.
	 * @param  {Element}  node  The DOM node the will be opened for.
	 * @return {string|false}   The menu items display text or false to hide the item.
	 */
	show: async(function*({ x, y, }) {
		console.log('show at', x, y);
		const { url, type, } = (yield runInTab(
			Tabs.activeTab,
			(x, y) => {
				console.log('content', x, y);
				const node = document.elementFromPoint(x, y);
				console.log('node', node.tagName);
				if (node.tagName == 'IMG') {
					return { url: node.src, type: 'image', };
				}
				const url = (function walk(node) {
					let background, match;
					return (background = window.getComputedStyle(node).backgroundImage)
					&& (match = background.match(/^url\(["']?(.*?)["']?\)/))
					&& match[1]
					|| node.parentNode && node.parentNode.ownerDocument && walk(node.parentNode);
				})(node);
				self.postMessage(url);
				return { url, type: 'background', };
			},
			x, y
		));
		console.log('message', type, url);
		this.element[!url ? 'setAttribute' : 'removeAttribute']('disabled', 'true');
		this.element.label = labels[type] || labels.base;
		this.url = url;
	}),

	/**
	 * Receives the messages SDKs 'click' events.
	 */
	onMessage() {
		if (this.ignoreNextInvoke) {
			this.ignoreNextInvoke = false;
		} else {
			this.search('_self').catch(this.error);
		}
	},

	/**
	 * Menu items click handler. Necessary to detect mouse-wheel-clicks and modifier keys.
	 */
	onClick({ button, ctrlKey, }) {
		console.log('item clicked', button, ctrlKey);
		(button === 1 || ctrlKey && (this.ignoreNextInvoke = true)) && this.search('_blank');
	},

	/**
	 * Starts the image search for a given url and target.
	 * @param  {string}  target  '_self' or '_blank'
	 * @param  {string}  url     Optional src-url of the image to search for, supports 'https?:', 'file:', 'resource:' and 'data:base64'. Default: this.url
	 * @return {Promise}         Resolves once the search is sent to Google.
	 */
	search(target, url) {
		url = url || this.url;
		return new Promise((resolve, reject) => {
			if (target == '_blank') {
				Tabs.open({
					url: 'about:blank',
					inBackground: true,
					onOpen: tab => resolve(this.load(tab, url)),
				});
			} else {
				const tab = Tabs.activeTab;
				tab.once('load', () => resolve(this.load(tab, url)));
				tab.url = 'about:blank';
			}
		});
	},

	/**
	 * Searches for an image in a given tab.
	 * @param {high-level Tab}   tab          The tab to perform the search in, should be navigated to 'about:blank'.
	 * @param {string}           url          Url specifying the image to search for, allowed protocols: [ http, https, file, chrome, resource, data:base64, ]
	 * @param {Boolean}          isData       If true, url may and must be a plain base64 string
	 * @async
	 */
	load: async(function*(tab, url, isData) {
		if ((/^https?:\/\//).test(url)) {
			return tab.url = Prefs.searchByUrlTarget.replace(/\${ ?url ?}|$/, encodeURIComponent(url));
		}
		if ((/^file:/).test(url)) {
			const path = File.join(...url.replace(/^file:\/*(\/|~|[A-Z]+:)/, '$1').split(/\//g)); // absolute path in Linux, Windows and OSX
			console.log('load file', path);
			if (!File.exists(path)) { throw new Error('Couldn\'t find file "'+ path +'"'); }
			const image = toBase64(File.read(path, 'b'));
			return this.load(tab, image, true);
		}
		if ((/^(resource|chrome):/).test(url)) {
			const image = toBase64(arrayBufferToString((yield HttpRequest(url, { responseType: 'arraybuffer', })).response));
			return this.load(tab, image, true);
		}
		if (isData || (/^data:/).test(url)) {
			const image = url.replace(/^.*?,/, '').replace(/\+/g, '-').replace(/\//g, '_');
			console.log('load data', image.length);
			return runInTab(
				tab,
				'../node_modules/es6lib/namespace.js', '../node_modules/es6lib/object.js', '../node_modules/es6lib/dom.js',
				options => {
					const { createElement, } = require('es6lib/dom');
					document.body.appendChild(createElement('form', {
						acceptCharset: 'UTF-8',
						enctype: 'multipart/form-data',
						method: 'post',
						action: options.url,
					}, [ createElement('input', {
						type: 'hidden',
						name: 'image_content',
						value: options.image,
					}), ]))
					.submit();
				},
				{ image, url: Prefs.searchByBinaryTarget, }
			);
		}
		throw new Error('Unsupported protocol "'+ url.replace(/:.*$/, '') +'"');
	}),

	/**
	 * Default error reporter.
	 */
	error(error) {
		console.error(error);
		viewFor(Windows.activeWindow).alert('Something went wrong, sorry: '+ (error && error.message || error));
	},

});

/**
 * Forwards click events to menu.onClick(). Necessary to detect mouse-wheel- and ctrl-clicks
 */
/*const clickHandler = event => (
	(/^menuitem$/i).test(event.target.tagName)
	&& event.target.label.startsWith(menu.label)
	&& menu.onClick(event)
);*/

/**
 * initialises the add-on for a window
 * called by high-levels Window.on('open', ...)
 * @param  {high-level window}   window    the window that just opened
 */
function windowOpened(window) {
	const { document, } = viewFor(window);
	const content = document.querySelector('#content');

	// document.querySelector('#contentAreaContextMenu').addEventListener('click', clickHandler);
	document.addEventListener('popupshowing', ({ target, clientX: x, clientY: y, }) => {
		if (target.id !== 'contentAreaContextMenu') { return; }
		const offset = content.getBoundingClientRect();
		x -= offset.x; y -= offset.y;
		console.log('xy', x, y);
		if (x < 0 || y < 0) { return; }
		const element = menu.element = document.querySelector('#context-findimage') || Array.filter(
			document.querySelectorAll('.addon-context-menu-item'),
			item => item.label === labels.init
		)[0];
		element.id = 'context-findimage';
		element.addEventListener('click', menu.onClick);
		menu.show({ x, y, });
	});
}

/**
 * unloads the addon for a window
 * called by high-levels Window.on('close', ...)
 * @param  {high-level window}   window    the window that just closed / is about to close (?)
 */
function windowClosed(window) {
	const { document, } = viewFor(window);
	// document.querySelector('#contentAreaContextMenu').removeEventListener('click', clickHandler);
}

/**
 * addons main entry point
 */
function startup() {
	menu = new ContextMenu();
	Array.forEach(Windows, windowOpened);
	Windows.on('open', windowOpened);
	Windows.on('close', windowClosed);
}

/**
 * removes all listeners and reverts all changes
 */
function shutdown() {
	console.log('disabling addon');
	Windows.removeListener('close', windowClosed);
	Windows.removeListener('open', windowOpened);
	Array.forEach(Windows, windowClosed);
	menu && menu.destroy && menu.destroy(); // destroy isn't always present ...
}

// make sdk run startup
exports.main = startup;

// respond to unload, unless its because of 'shutdown' (performance)
exports.onUnload = reason => {
	if (reason !== 'shutdown') {
		shutdown();
	}
};

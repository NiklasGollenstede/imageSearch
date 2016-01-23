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
const { Item, Menu, SelectorContext, } = require("sdk/context-menu");
const Tabs = require("sdk/tabs");
const File = require("sdk/io/file");
const NameSpace = require('sdk/core/namespace').ns;
const { OS, } = Cu.import("resource://gre/modules/osfile.jsm", {});
Cu.importGlobalProperties([ 'btoa', ]); /* global btoa */
const toBase64 = btoa;

const {
	concurrent: { async, },
	dom: { createElement, },
	network: { HttpRequest, mimeTypes, arrayBufferToString, },
	functional: { noop, Logger, log, },
} = require('es6lib');
const runInTab = require('es6lib/runInTab');

const SCRIPT = 'contentScript';
const labels = {
	init: 'uninitialised+sHg8QRzF9a2qpccgRd2y',
	pending: 'Searching \u2026',
	none: 'No image found',
	one: 'Image search for ',
	more: 'Image search for \u2026',
};


let _private; // NameSpace to add private values to xul elements
let menu; // global ContextMenu instance

function ContextMenu() {
	this.onInvoke = this.onInvoke.bind(this);
	this.items = [ new Item({ label: 'none', }), ];
	this.item = new Menu(this);
}
Object.assign(ContextMenu.prototype, {
	label: labels.init,
	image: 'https://www.google.com/images/icons/product/images-32.gif',
	context: SelectorContext('*'),

	/**
	 * Called when the context menu is opened at { x, y, }. Retrieves meta information of any kind of image at the position in the current tab
	 * and shows the <menu> as appropriate.
	 * @param  {<menu>}  element   The item instance whose context menu showed up.
	 * @param  {object}  position  { x, y, } coordinates of the target location.
	 */
	onShow: async(function*(element, { x, y, }) {
		const items = element.querySelector('menupopup');
		element.setAttribute('disabled', 'true');
		element.label = labels.pending;
		items.textContent = '';

		const images = (yield runInTab(
			Tabs.activeTab,
			(x, y) => {
				const images = [ ];
				(function find(node) {
					if (!node || node === document.documentElement) { return; }

					if (node.tagName == 'IMG') {
						images.push({ url: node.src, type: 'image', title: node.title, alt: node.alt, id: node.id, className: node.className, });
					}
					[ null, ':before', ':after', ].forEach((pseudo, background, match) => {
						(background = window.getComputedStyle(node, pseudo).backgroundImage)
						&& (match = background.match(/^url\(["']?(.*?)["']?\)/)) && match[1]
						&& images.push({ url: match[1], type: pseudo || 'background', tagName: node.tagName, title: node.title, id: node.id, className: node.className, });
					});

					const visibility = node.style.visibility;
					const priority = node.style.getPropertyPriority('visibility');
					node.style.setProperty('visibility', 'hidden', 'important');
					const next = document.elementFromPoint(x, y);
					next !== node && find(next);
					node.style.setProperty('visibility', visibility, priority);
				})(document.elementFromPoint(x, y));
				return images;
			},
			x, y
		));

		if (!images.length) { return element.label = labels.none; }

		element.removeAttribute('disabled');
		this.defaultImage = images[0];
		element.label = images.length === 1 ? imageTitle(images[0], 30, labels.one) : labels.more;

		images.forEach(image => addInvokeListener(
			items.appendChild(items.ownerDocument.createElement('menuitem')),
			({ button, ctrlKey, }) => {
				!image.used && (image.used = true)
				&& this.search(button === 1 || ctrlKey ? '_blank' : '_self', image.url);
			}).setAttribute('label', imageTitle(image, 60))
		);
	}),

	/**
	 * Main menu item click handler to allow direct clicks on the <menu> item.
	 */
	onInvoke({ button, ctrlKey, }) {
		!this.defaultImage.used && (this.defaultImage.used = true)
		&& this.search(button === 1 || ctrlKey ? '_blank' : '_self', this.defaultImage.url);
	},

	/**
	 * Starts the image search for a given url and target.
	 * @param  {string}  target  '_self' or '_blank'
	 * @param  {string}  url     Src-url of the image to search for, supports 'https?:', 'file:', 'resource:' and 'data:base64'.
	 * @return {Promise}         Resolves once the search is sent to Google.
	 */
	search(target, url) {
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

	destroy() {
		return this.item.destroy();
	},

});

// handler may be called twice (click + command)
function addInvokeListener(element, handler) {
	const popup = element.ownerDocument.querySelector('#contentAreaContextMenu');
	const wrapper = event => event.target === element && popup.hidePopup() === handler(event);
	element.addEventListener('click', wrapper);
	element.addEventListener('command', wrapper);
	return element;
}

function imageTitle(image, maxLength, title = '') {
	title += {
		':before': ':before-image',
		':after': ':after-image',
		'image': 'Image',
		'background': 'background',
	}[image.type] +' ';
	const name = image.title || image.alt || image.tagName || image.id || image.className || image.url;
	return title + shorten('`'+ name +'´', maxLength - title.length);
}

function shorten(string, length) {
	if (length < 5) { return ''; }
	if (string.length <= length) { return string; }
	if (length < 10) { return string.slice(0, 8) +'\u2026'+ string.slice(-1); }
	const hasSuffix = string.match(/(\..{1,5})$/);
	if (hasSuffix) { return string.slice(0, length - hasSuffix[1].length - 1) +'\u2026'+ hasSuffix[1]; }
	return string.slice(0, length - 2) +'\u2026'+ string.slice(-1);
}

/**
 * initialises the add-on for a window
 * called by high-levels Window.on('open', ...)
 * @param  {high-level window}   window    the window that just opened
 */
function windowOpened(window) {
	const { gBrowser, document, } = viewFor(window);
	const content = document.querySelector('#content');

	const onPopup = _private(gBrowser).onPopup = ({ target, clientX: x, clientY: y, }) => {
		if (target.id !== 'contentAreaContextMenu') { return; }
		const offset = content.getBoundingClientRect();
		x -= offset.x; y -= offset.y;
		if (x < 0 || y < 0) { return; }
		let element = document.querySelector('#context-findimage');
		if (!element) {
			element = Array.filter(
				document.querySelectorAll('.addon-context-menu-item'),
				item => item.label === labels.init
			)[0];
			element.id = 'context-findimage';
			addInvokeListener(element, menu.onInvoke);
		}
		menu.onShow(element, { x, y, });
	};

	document.addEventListener('popupshowing', onPopup);
}

/**
 * unloads the addon for a window
 * called by high-levels Window.on('close', ...)
 * @param  {high-level window}   window    the window that just closed / is about to close (?)
 */
function windowClosed(window) {
	const { gBrowser, document, } = viewFor(window);
	const { onPopup, } = _private(gBrowser);
	document.removeEventListener('popupshowing', onPopup);
}

/**
 * addons main entry point
 */
function startup() {
	_private = NameSpace();
	menu = new ContextMenu();
	Array.forEach(Windows, windowOpened);
	Windows.on('open', windowOpened);
	Windows.on('close', windowClosed);
}

/**
 * removes all listeners and reverts all changes
 */
function shutdown() {
	Windows.removeListener('close', windowClosed);
	Windows.removeListener('open', windowOpened);
	Array.forEach(Windows, windowClosed);
	menu && menu.destroy();
	_private = null;
}

// make sdk run startup
exports.main = startup;

// respond to unload, unless its because of 'shutdown' (performance)
exports.onUnload = reason => {
	if (reason !== 'shutdown') {
		shutdown();
	}
};

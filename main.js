'use strict';

/**
 * @description Adds a context menu option 'Google Search for (background) image' to the page context.
 * Mouse-wheel-clicking or clicking while pressing 'Ctrl' will open the Google Images reverse search with the selected image in a new tab.
 * Left clicking or invoking the option otherwise opens the search in the current tab.
 * Works with linked/online, local, firefox-internal and inline images.
 */

const { Cu, Cc, Ci, components: Components, } = require("chrome");
const { viewFor } = require("sdk/view/core");
const Windows = require("sdk/windows").browserWindows;
const { prefs: Prefs, } = require("sdk/simple-prefs");
const { Item, Menu, SelectorContext, } = require("sdk/context-menu");
const Tabs = require("sdk/tabs");
const File = require("sdk/io/file");
const NameSpace = require('sdk/core/namespace').ns;
Cu.importGlobalProperties([ 'btoa', 'URL', ]); /* globals btoa, URL */ const toBase64 = btoa;
const DNS = Cc['@mozilla.org/network/dns-service;1'].createInstance(Ci.nsIDNSService);
const { currentThread, } = Cc['@mozilla.org/thread-manager;1'].getService(Ci.nsIThreadManager);

const {
	concurrent: { async, },
	dom: { createElement, },
	network: { HttpRequest, mimeTypes, arrayBufferToString, },
	functional: { noop, Logger, log, },
} = require('es6lib');
const runInTab = require('es6lib/runInTab');

const SCRIPT = 'contentScript';
const labels = {
	init: 'Failed to load',
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
				(function find(node, x, y) {
					if (!node || node === node.ownerDocument.documentElement) { return; }
					if (node.tagName === 'IFRAME') {
						const offset = node.getBoundingClientRect();
						const _x = x - offset.x, _y = y - offset.y;
						find(node.contentDocument.elementFromPoint(_x, _y), _x, _y);
					}

					node.tagName === 'IMG' && images.push({
						url: node.currentSrc || node.src, type: 'image',
						title: node.title, alt: node.alt, id: node.id,
					});
					[ null, ':before', ':after', ].forEach((pseudo, background, match) => {
						(background = window.getComputedStyle(node, pseudo).backgroundImage)
						&& (match = background.match(/^url\(["']?(.*?)["']?\)/)) && match[1]
						&& images.push({
							url: match[1], type: pseudo || 'background',
							title: node.title, id: node.id,
							tagName: (/^(?:article|body|button|footer|header|html|input|label|.*?-.*)$/i).test(node.tagName) && node.tagName,
						});
					});

					const visibility = node.style.visibility;
					const priority = node.style.getPropertyPriority('visibility');
					node.style.setProperty('visibility', 'hidden', 'important');
					const next = node.ownerDocument.elementFromPoint(x, y);
					next !== node && find(next, x, y);
					node.style.setProperty('visibility', visibility, priority);
				})(document.elementFromPoint(x, y), x, y);
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
			}).setAttribute('label', imageTitle(image, 70))
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
					onOpen: tab => this.load(tab, url).then(resolve, reject),
				});
			} else {
				const tab = Tabs.activeTab;
				tab.once('load', () => this.load(tab, url).then(resolve, reject));
				tab.url = 'about:blank';
			}
		})
		.catch(this.error);
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
			if ((yield isPublicHost(url))) {
				console.log('public ip', url);
				return tab.url = Prefs.searchByUrlTarget.replace(/\${ ?url ?}|$/, encodeURIComponent(url));
			}
			console.log('private ip', url);
		}
		if ((/^file:/).test(url)) {
			const path = File.join(...decodeURI(url).replace(/^file:\/*(\/|~|[A-Z]+:)/, '$1').split(/\//g)); // absolute path in Linux, Windows and OSX
			if (!File.exists(path)) { throw new Error(`Couldn't find the file "${ path }"`); }
			const image = toBase64(File.read(path, 'b'));
			return this.load(tab, image, true);
		}
		if ((/^(?:blob|chrome|https?|resource):/).test(url)) {
			const image = toBase64(arrayBufferToString((yield HttpRequest(url, { responseType: 'arraybuffer', })).response));
			return this.load(tab, image, true);
		}
		if (isData || (/^data:/).test(url)) {
			const image = url.replace(/^.*?,/, '').replace(/\+/g, '-').replace(/\//g, '_');
			return (yield runInTab(
				tab,
				options => {
					const form = document.body.appendChild(document.createElement('form'));
					form.acceptCharset = 'UTF-8';
					form.enctype = 'multipart/form-data';
					form.method  = 'post';
					form.action  = options.url;
					const upload = form.appendChild(document.createElement('input'));
					upload.type  = 'hidden';
					upload.name  = 'image_content';
					upload.value = options.image;
					form.submit();
				},
				{ image, url: Prefs.searchByBinaryTarget, }
			));
		}
		throw new Error('Unsupported protocol "'+ url.replace(/:.*$/, '') +'"');
	}),

	/**
	 * Default error reporter.
	 */
	error(error) {
		console.error(error);
		viewFor(Windows.activeWindow).alert('Something went wrong, sorry: '+ (error && error.message || error));
		throw error;
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

function imageTitle(image, maxLength, title) {
	title = (title || '') + ({
		':before': ':before-image ',
		':after': ':after-image ',
		'image': '',
		'background': 'background ',
	}[image.type]);
	const name = shorten(decodeURI(image.title || image.alt || image.id || image.tagName || image.url), maxLength - title.length);
	name && (title += '“'+ name +'”');
	return title;
}

function shorten(string, length) {
	if (length < 7) { return ''; } // to short
	if (string.length <= length) { return string; } // short enough
	if (length < 10) { return string.slice(0, 9) +'…'; } // to short to bother
	if ((/^data:/).test(string)) { return (/^data:[^,;]{0,10}.?/).exec(string)[0] +'…'; } // data:-url
	if ((/^[\w-]{2,30}:\/\//).test(string)) { try { // some other url
		const url = new URL(string);
		if (url.origin.length + url.pathname.length <= length) { return url.origin + url.pathname; }
		let out = url.origin.length < length / 2 ? url.origin +'/' : url.protocol.length < length / 2 ? url.protocol +'//' : '';
		return out +'…'+ url.pathname.slice(-(length - out.length - 1));
	} catch(error) { console.error(error); } }
	return string.slice(0, length - 2) +'…'; // whatever
}

const hostToIP = (host, flags = 0, recurse = 10) => new Promise((resolve, reject) => DNS.asyncResolve(host, flags, { onLookupComplete(_, record, status) { try {
	if ((status & 0x80000000) !== 0) { reject(new Error(`DNS lookup of "${ host }" with flags 0b${ flags.toString(2) } failed`)); }
	const ip = record.getNextAddrAsString();
	if ((/^[12]?\d{1,2}\.[12]?\d{1,2}\.[12]?\d{1,2}\.[12]?\d{1,2}$/).test(ip)) { resolve(ip); }
	else if (recurse > 0) { hostToIP(ip, flags, --recurse).then(resolve, reject); }
	else { reject(new Error(`DNS lookup of "${ host }" with flags 0b${ flags.toString(2) } failed (too much recursion)`)); }
} catch (error) { reject(error); } }, }, currentThread));

const isPublicHost = async(function*(url) {
	try {
		const name = new URL(url).hostname;
		const ipv4 = (yield hostToIP(name, DNS.RESOLVE_DISABLE_IPV6)).split('.').map(_=>+_);
		return !(false
			|| (ipv4[0] === 127)                                  // 127.0.0.0/8      loopback
			|| (ipv4[0] ===  10)                                  // 10.0.0.0/8       private
			|| (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4 <= 31)   // 172.16.0.0/12    private
			|| (ipv4[0] === 192 && ipv4[1] === 168)               // 192.168.0.0/16   private
			|| (ipv4[0] === 169 && ipv4[1] === 254)               // 169.254.0.0/16   link-local
		);
	} catch (error) { console.error('Error', error.stack || error); }
	return false; // who knows ...
});

/**
 * initialises the add-on for a window
 * called by high-levels Window.on('open', ...)
 * @param  {high-level window}   window    the window that just opened
 */
function windowOpened(window) {
	const { gBrowser, document, } = viewFor(window);
	const content = document.querySelector('#content');

	const onPopup = _private(gBrowser).onPopup = event => {
		if (event.target.id !== 'contentAreaContextMenu') { return; }
		const offset = content.getBoundingClientRect();
		const x = (event.clientX || -event.offsetX) - offset.x;
		const y = (event.clientY || -event.offsetY) - offset.y;
		if (x < 0 || y < 0) { return; }
		let element = document.querySelector('#context-findimage');
		if (!element) {
			element = Array.filter(
				document.querySelectorAll('.addon-context-menu-item'),
				item => item.label === labels.init && item.image === menu.image
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

# Server Commands Extension

A unified API for server-driven web applications. Send commands to control swaps, events, navigation, and history from your server using hypermedia.

## Setup

1. Include the extension:
```html
<script src="https://unpkg.com/htmx.org@2.0.2/dist/ext/server-commands.js"></script>
```

2. Enable it globally:
```html
<body hx-ext="server-commands">
<!-- Your content -->
</body>
```

3. Send `<htmx>` commands from your server:
```html
<htmx target="#my-div" swap="outerHTML">
    <div id="my-div">Updated content!</div>
</htmx>
<htmx trigger="myEvent"></htmx>
```

## Commands

| Attribute              | Behaves like                                                                                                                                                     | Example                          |
|------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------|
| `target`               | [`hx-target`](https://htmx.org/attributes/hx-target/) attribute or [`HX-Retarget`](https://htmx.org/reference/#response_headers) response header                 | `target="#content"`              |
| `swap`                 | [`hx-swap`](https://htmx.org/attributes/hx-swap/) attribute (including modifiers) or [`HX-Reswap`](https://htmx.org/reference/#response_headers) response header | `swap="beforeend scroll:bottom"` |
| `select`               | [`hx-select`](https://htmx.org/attributes/hx-select/) attribute or [`HX-Reselect`](https://htmx.org/reference/#response_headers) response header                 | `select=".result"`               |
| `trigger`              | [`HX-Trigger`](https://htmx.org/headers/hx-trigger/) response header                                                                                             | `trigger="dataUpdated"`          |
| `trigger-after-swap`   | [`HX-Trigger-After-Swap`](https://htmx.org/headers/hx-trigger/) response header                                                                                  | `trigger-after-swap="swapDone"`  |
| `trigger-after-settle` | [`HX-Trigger-After-Settle`](https://htmx.org/headers/hx-trigger/) response header                                                                                | `trigger-after-settle="settled"` |
| `redirect`             | [`HX-Redirect`](https://htmx.org/headers/hx-redirect/) response header                                                                                           | `redirect="/login"`              |
| `refresh`              | [`HX-Refresh`](https://htmx.org/headers/hx-refresh/) response header                                                                                             | `refresh="true"`                 |
| `location`             | [`HX-Location`](https://htmx.org/headers/hx-location/) response header                                                                                           | `location="/dashboard"`          |
| `push-url`             | [`HX-Push-Url`](https://htmx.org/headers/hx-push-url/) response header                                                                                           | `push-url="/new-page"`           |
| `replace-url`          | [`HX-Replace-Url`](https://htmx.org/headers/hx-replace-url/) response header                                                                                     | `replace-url="/updated"`         |

## Client vs Server Control Comparison

This extension lets you move UI control logic from the client to the server. Here are side-by-side examples:

### Content Swapping
**Client-side (traditional htmx):**
```html
<!-- Client triggers request, and says how to swap with incoming content -->
<button
        hx-get="/update"
        hx-target="#content"
        hx-swap="innerHTML"
>
    Update
</button>

<!-- Server just sends back the content -->
<p>Updated content</p>
```

**Server-side (with `server-commands` extension):**
```html
<!-- Client just triggers request -->
<button
        hx-get="/update"
        hx-swap="none"
>
    Update
</button>

<!-- Server response contains the instructions on how to swap incoming content -->
<htmx target="#content" swap="innerHTML">
    <p>Updated content</p>
</htmx>
```

*Note: We use `hx-swap="none"` as a workaround to prevent the button from being swapped out when clicked.*

## Examples

### Basic Content Swap
```html
<htmx target="#content" swap="innerHTML">
    <p>New content from server!</p>
</htmx>
```

### Multiple Commands in Single Response
```html
<htmx target="#status" swap="outerHTML">
    <div id="status" class="updated">Status updated!</div>
</htmx>
<htmx trigger="statusUpdated"></htmx>
<htmx push-url="/new-page"></htmx>
```

## Custom Events

The extension provides these events for programmatic control:

- `htmx:beforeServerCommand`: Fired before processing each `<htmx>` tag. Return `false` to cancel processing.
- `htmx:afterServerCommand`: Fired after successfully processing each `<htmx>` tag.
- `htmx:serverCommandError`: Fired when an error occurs during command processing.

### Event Examples

```javascript
// Cancel a specific command
document.body.addEventListener('htmx:beforeServerCommand', function(event) {
    const commandElement = event.detail.commandElement;
    if (commandElement.hasAttribute('redirect')) {
        event.preventDefault(); // Cancel redirect commands
    }
});

// Handle command errors
document.body.addEventListener('htmx:serverCommandError', function(event) {
    console.error('Server command error:', event.detail.error);
});
```

## But isn't this just `hx-swap-oob`?

It is, but out-of-band swaps in their current form are very limited.

They only support setting the swap strategy (without modifiers), and the target.

On the other hand, server commands support all `hx-target`, `hx-select`, `hx-swap` features (including modifiers) plus response headers like `HX-Trigger` and `HX-Push-Url` - essential for SSE/WebSocket apps where headers aren't available.


## Experimental Notice

This extension is experimental and copies internal htmx functions, making it more bloated than it could be. If valuable to the community, it may be integrated into htmx core, which would be a much smaller size. [Share feedback](https://github.com/bigskysoftware/htmx/discussions).

# Transclusion Demo

Back to [[index]].

## Block-reference navigation

Without the `!` prefix, `[[file#block-id]]` navigates to the block on click:

- Jump to [[Projects/Nexus-Editor#context]] — the heading block
- Jump to [[Projects/Nexus-Editor#some-block]] — explicit `^{id}` paragraph

## Embedding specific blocks

Use `![[file#block-id]]` to embed a block's content inline:

![[Projects/Nexus-Editor#context]]

Notice the breadcrumb header above — click it to edit the reference.

## Embedding paragraphs

Paragraphs tagged with `^{id}` can be transcluded with `#id`:

![[Projects/Nexus-Editor#some-block]]

## Embedding full files

Omitting the block ID embeds the entire file:

![[Topics/AI]]

## Edge cases

- Unresolved file: ![[ghost-demo]]
- Unresolved block: ![[Topics/AI#no-such-block]]

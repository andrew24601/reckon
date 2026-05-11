#import <Cocoa/Cocoa.h>

#include <string>

static NSString *toNSString(const std::string &value) {
  return [NSString stringWithUTF8String:value.c_str()];
}

static std::string buildSubtitle() {
  return "Built by Reckon with Objective-C++ and AppKit";
}

static void installMenuBar(void) {
  NSMenu *menuBar = [[NSMenu alloc] init];
  NSMenuItem *appMenuItem = [[NSMenuItem alloc] init];
  [menuBar addItem:appMenuItem];
  [NSApp setMainMenu:menuBar];

  NSMenu *appMenu = [[NSMenu alloc] init];
  NSString *processName = [[NSProcessInfo processInfo] processName];
  NSString *quitTitle = [@"Quit " stringByAppendingString:processName];
  NSMenuItem *quitItem = [[NSMenuItem alloc] initWithTitle:quitTitle action:@selector(terminate:) keyEquivalent:@"q"];
  [appMenu addItem:quitItem];
  [appMenuItem setSubmenu:appMenu];
}

@interface HelloAppDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate>

@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) NSTextField *statusLabel;

@end

@implementation HelloAppDelegate

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
  (void)sender;
  return YES;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;

  NSRect frame = NSMakeRect(0, 0, 760, 440);
  NSWindowStyleMask styleMask = NSWindowStyleMaskTitled
    | NSWindowStyleMaskClosable
    | NSWindowStyleMaskMiniaturizable
    | NSWindowStyleMaskResizable;

  self.window = [[NSWindow alloc] initWithContentRect:frame styleMask:styleMask backing:NSBackingStoreBuffered defer:NO];
  [self.window setTitle:@"Hello"];
  [self.window center];
  [self.window setDelegate:self];

  NSView *contentView = [self.window contentView];

  NSTextField *headline = [[NSTextField alloc] initWithFrame:NSMakeRect(40, 320, 680, 42)];
  [headline setStringValue:@"Objective-C++ macOS app"];
  [headline setBezeled:NO];
  [headline setDrawsBackground:NO];
  [headline setEditable:NO];
  [headline setSelectable:NO];
  [headline setFont:[NSFont boldSystemFontOfSize:30]];
  [headline setAutoresizingMask:NSViewWidthSizable | NSViewMinYMargin];

  NSTextField *subtitle = [[NSTextField alloc] initWithFrame:NSMakeRect(40, 250, 680, 56)];
  [subtitle setStringValue:toNSString(buildSubtitle())];
  [subtitle setBezeled:NO];
  [subtitle setDrawsBackground:NO];
  [subtitle setEditable:NO];
  [subtitle setSelectable:NO];
  [subtitle setFont:[NSFont systemFontOfSize:16]];
  [subtitle setTextColor:[NSColor secondaryLabelColor]];
  [subtitle setAutoresizingMask:NSViewWidthSizable | NSViewMinYMargin];

  self.statusLabel = [[NSTextField alloc] initWithFrame:NSMakeRect(40, 150, 680, 24)];
  [self.statusLabel setStringValue:@"The button below is wired up through AppKit, not a terminal printf."];
  [self.statusLabel setBezeled:NO];
  [self.statusLabel setDrawsBackground:NO];
  [self.statusLabel setEditable:NO];
  [self.statusLabel setSelectable:NO];
  [self.statusLabel setAutoresizingMask:NSViewWidthSizable | NSViewMinYMargin];

  NSButton *button = [[NSButton alloc] initWithFrame:NSMakeRect(40, 92, 220, 36)];
  [button setTitle:@"Open Cocoa Sheet"];
  [button setBezelStyle:NSBezelStyleRounded];
  [button setTarget:self];
  [button setAction:@selector(showGreeting:)];
  [button setAutoresizingMask:NSViewMaxXMargin | NSViewMinYMargin];

  [contentView addSubview:headline];
  [contentView addSubview:subtitle];
  [contentView addSubview:self.statusLabel];
  [contentView addSubview:button];

  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
}

- (void)showGreeting:(id)sender {
  (void)sender;

  [self.statusLabel setStringValue:@"Sheet opened from an Objective-C++ AppKit action."];

  NSAlert *alert = [[NSAlert alloc] init];
  [alert setMessageText:@"Hello from Cocoa"];
  [alert setInformativeText:@"This sample is a native macOS windowed app built from a .mm source file."];
  [alert addButtonWithTitle:@"Nice"];
  [alert beginSheetModalForWindow:self.window completionHandler:nil];
}

@end

int main(int argc, const char *argv[]) {
  (void)argc;
  (void)argv;

  @autoreleasepool {
    NSApplication *application = [NSApplication sharedApplication];
    HelloAppDelegate *delegate = [[HelloAppDelegate alloc] init];

    [application setActivationPolicy:NSApplicationActivationPolicyRegular];
    [application setDelegate:delegate];
    installMenuBar();
    [application run];
  }

  return 0;
}
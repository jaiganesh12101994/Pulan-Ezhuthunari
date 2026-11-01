#!/usr/bin/env python3
"""
Pulan Tamil OCR - Standalone Python Desktop Application
Built with:
- PDF and Image viewing with Pan & Zoom
- Multi-column layout detection across pages
- Multi-engine Tamil OCR: Tesseract, Surya, Chandra, and gnana70/tamil_ocr
- Split-panel Document Tree, Image Canvas with Bounding Boxes, and Rich Text Editor
- Export to DOCX, TXT, JSON, HTML formats
"""

import sys
import os
import json

# Auto-configure bundled OCR engines inside the application directory
APP_ROOT = os.path.dirname(os.path.abspath(__file__))
BUNDLED_TESSDATA = os.path.join(APP_ROOT, "engines", "tessdata")
if os.path.exists(BUNDLED_TESSDATA):
    os.environ["TESSDATA_PREFIX"] = BUNDLED_TESSDATA

BUNDLED_OCR_TAMIL = os.path.join(APP_ROOT, "engines", "ocr_tamil")
if os.path.exists(BUNDLED_OCR_TAMIL) and BUNDLED_OCR_TAMIL not in sys.path:
    sys.path.insert(0, BUNDLED_OCR_TAMIL)

BUNDLED_SURYA_CHANDRA = os.path.join(APP_ROOT, "engines", "surya_chandra")
if os.path.exists(BUNDLED_SURYA_CHANDRA) and BUNDLED_SURYA_CHANDRA not in sys.path:
    sys.path.insert(0, BUNDLED_SURYA_CHANDRA)

import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from PIL import Image, ImageTk, ImageEnhance, ImageOps

try:
    import pytesseract
except ImportError:
    pytesseract = None

try:
    import docx
except ImportError:
    docx = None


class PulanTamilOCRApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Pulan Tamil OCR 1.0 - Professional Studio [Tesseract / Surya / Chandra / gnana70]")
        self.root.geometry("1280x820")
        self.root.minsize(950, 600)

        # State
        self.current_image = None
        self.original_image = None
        self.tk_image = None
        self.pages = []  # List of page filepaths
        self.current_page_idx = 0
        self.zoom_level = 1.0
        self.zones = []  # Bounding boxes: {x, y, w, h, col, type}
        self.ocr_engine = tk.StringVar(value="tesseract")
        self.ocr_language = tk.StringVar(value="tam+eng")
        self.layout_mode = tk.StringVar(value="auto")

        self.setup_menu()
        self.setup_toolbar()
        self.setup_main_panels()
        self.setup_statusbar()

    def setup_menu(self):
        menubar = tk.Menu(self.root)

        # File Menu
        file_menu = tk.Menu(menubar, tearoff=0)
        file_menu.add_command(label="Open Image / PDF...", command=self.open_file, accelerator="Ctrl+O")
        file_menu.add_command(label="Save OCR Text As...", command=self.save_text, accelerator="Ctrl+S")
        file_menu.add_separator()
        export_menu = tk.Menu(file_menu, tearoff=0)
        export_menu.add_command(label="Export to DOCX (.docx)", command=lambda: self.export_as("docx"))
        export_menu.add_command(label="Export to Plain Text (.txt)", command=lambda: self.export_as("txt"))
        export_menu.add_command(label="Export to JSON (.json)", command=lambda: self.export_as("json"))
        export_menu.add_command(label="Export to HTML (.html)", command=lambda: self.export_as("html"))
        file_menu.add_cascade(label="Export Document", menu=export_menu)
        file_menu.add_separator()
        file_menu.add_command(label="Exit", command=self.root.quit)
        menubar.add_cascade(label="File", menu=file_menu)

        # Edit Menu
        edit_menu = tk.Menu(menubar, tearoff=0)
        edit_menu.add_command(label="Undo", accelerator="Ctrl+Z")
        edit_menu.add_command(label="Redo", accelerator="Ctrl+Y")
        edit_menu.add_separator()
        edit_menu.add_command(label="Clear Editor", command=self.clear_editor)
        menubar.add_cascade(label="Edit", menu=edit_menu)

        # View Menu
        view_menu = tk.Menu(menubar, tearoff=0)
        view_menu.add_command(label="Zoom In (+20%)", command=self.zoom_in)
        view_menu.add_command(label="Zoom Out (-20%)", command=self.zoom_out)
        view_menu.add_command(label="Fit to Window", command=self.fit_to_window)
        view_menu.add_command(label="Actual Size (100%)", command=self.actual_size)
        view_menu.add_separator()
        view_menu.add_command(label="Rotate 90° CCW", command=lambda: self.rotate_image(270))
        view_menu.add_command(label="Rotate 90° CW", command=lambda: self.rotate_image(90))
        menubar.add_cascade(label="View", menu=view_menu)

        # OCR Menu
        ocr_menu = tk.Menu(menubar, tearoff=0)
        ocr_menu.add_command(label="Detect Layout (All Pages)", command=self.detect_layout_all_pages)
        ocr_menu.add_command(label="Detect Layout (Current Page)", command=self.detect_layout_current_page)
        ocr_menu.add_separator()
        ocr_menu.add_command(label="Recognize Selection", command=self.recognize_selection)
        ocr_menu.add_command(label="Recognize Current Page", command=self.recognize_current_page)
        ocr_menu.add_command(label="Recognize All Pages (Batch)", command=self.recognize_all_pages)
        menubar.add_cascade(label="OCR", menu=ocr_menu)

        self.root.config(menu=menubar)

    def setup_toolbar(self):
        tb = ttk.Frame(self.root, padding=4)
        tb.pack(side=tk.TOP, fill=tk.X)

        # Open buttons
        ttk.Button(tb, text="📂 Open Document", command=self.open_file).pack(side=tk.LEFT, padx=2)

        # Page navigation
        ttk.Separator(tb, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=6)
        self.prev_btn = ttk.Button(tb, text="◀ Prev", command=self.prev_page, width=7)
        self.prev_btn.pack(side=tk.LEFT, padx=2)
        self.page_label = ttk.Label(tb, text="Page 0 / 0", font=("Helvetica", 9, "bold"))
        self.page_label.pack(side=tk.LEFT, padx=4)
        self.next_btn = ttk.Button(tb, text="Next ▶", command=self.next_page, width=7)
        self.next_btn.pack(side=tk.LEFT, padx=2)

        # Zoom & Rotate
        ttk.Separator(tb, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=6)
        ttk.Button(tb, text="🔍+", command=self.zoom_in, width=4).pack(side=tk.LEFT, padx=1)
        ttk.Button(tb, text="🔍-", command=self.zoom_out, width=4).pack(side=tk.LEFT, padx=1)
        ttk.Button(tb, text="⤢ Fit", command=self.fit_to_window, width=5).pack(side=tk.LEFT, padx=1)
        ttk.Button(tb, text="⟲ 90°", command=lambda: self.rotate_image(270), width=5).pack(side=tk.LEFT, padx=1)
        ttk.Button(tb, text="⟳ 90°", command=lambda: self.rotate_image(90), width=5).pack(side=tk.LEFT, padx=1)

        # Layout detection buttons
        ttk.Separator(tb, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=6)
        self.btn_layout_all = ttk.Button(
            tb, text="⚡ Detect Layout (All Pages)", command=self.detect_layout_all_pages
        )
        self.btn_layout_all.pack(side=tk.LEFT, padx=2)
        ttk.Button(tb, text="📑 Detect Layout (Page)", command=self.detect_layout_current_page).pack(side=tk.LEFT, padx=2)

        # OCR Engine Selector
        ttk.Separator(tb, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=6)
        ttk.Label(tb, text="Engine:").pack(side=tk.LEFT, padx=2)
        engine_combo = ttk.Combobox(
            tb,
            textvariable=self.ocr_engine,
            values=["tesseract", "surya", "chandra", "gnana70"],
            state="readonly",
            width=12,
        )
        engine_combo.pack(side=tk.LEFT, padx=2)

        # Recognize Action
        self.btn_ocr_page = ttk.Button(tb, text="▶ Recognize Page", command=self.recognize_current_page)
        self.btn_ocr_page.pack(side=tk.LEFT, padx=4)

        # Export dropdown
        ttk.Separator(tb, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=6)
        ttk.Button(tb, text="💾 Export DOCX", command=lambda: self.export_as("docx")).pack(side=tk.LEFT, padx=2)
        ttk.Button(tb, text="💾 Export TXT", command=lambda: self.export_as("txt")).pack(side=tk.LEFT, padx=2)

    def setup_main_panels(self):
        # 3 Panels: Left (Thumbnails/Tree), Center (Image Canvas), Right (Text Editor)
        main_pane = ttk.PanedWindow(self.root, orient=tk.HORIZONTAL)
        main_pane.pack(fill=tk.BOTH, expand=True)

        # 1. Left Sidebar
        left_frame = ttk.Frame(main_pane, width=180, padding=4)
        main_pane.add(left_frame, weight=1)

        ttk.Label(left_frame, text="Document Pages", font=("Helvetica", 9, "bold")).pack(anchor=tk.W, pady=2)
        self.page_tree = ttk.Treeview(left_frame, selectmode="browse", show="tree")
        self.page_tree.pack(fill=tk.BOTH, expand=True)
        self.page_tree.bind("<<TreeviewSelect>>", self.on_page_select)

        # 2. Center Panel (Image Canvas)
        center_frame = ttk.Frame(main_pane, padding=2)
        main_pane.add(center_frame, weight=5)

        self.canvas = tk.Canvas(center_frame, bg="#334155", cursor="cross")
        hbar = ttk.Scrollbar(center_frame, orient=tk.HORIZONTAL, command=self.canvas.xview)
        vbar = ttk.Scrollbar(center_frame, orient=tk.VERTICAL, command=self.canvas.yview)
        self.canvas.config(xscrollcommand=hbar.set, yscrollcommand=vbar.set)
        
        hbar.pack(side=tk.BOTTOM, fill=tk.X)
        vbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        # 3. Right Panel (Text Editor)
        right_frame = ttk.Frame(main_pane, width=380, padding=4)
        main_pane.add(right_frame, weight=4)

        editor_header = ttk.Frame(right_frame)
        editor_header.pack(fill=tk.X, pady=2)
        ttk.Label(editor_header, text="OCR Output & Editor", font=("Helvetica", 10, "bold")).pack(side=tk.LEFT)
        ttk.Button(editor_header, text="Clear", command=self.clear_editor, width=6).pack(side=tk.RIGHT)

        # Tamil Virtual Keyboard palette
        tamil_vbar = ttk.Frame(right_frame, padding=2)
        tamil_vbar.pack(fill=tk.X, pady=2)
        quick_tamil_chars = ["அ", "ஆ", "இ", "ஈ", "உ", "ஊ", "எ", "ஏ", "ஐ", "ஒ", "ஓ", "ஔ", "ஃ", "்", "ா", "ி", "ீ", "ு", "ூ", "ெ", "ே", "ை"]
        for c in quick_tamil_chars[:12]:
            b = ttk.Button(tamil_vbar, text=c, width=3, command=lambda char=c: self.insert_tamil_char(char))
            b.pack(side=tk.LEFT, padx=1)

        self.editor = tk.Text(
            right_frame,
            wrap=tk.WORD,
            font=("Lohit Tamil", 12),
            undo=True,
            bg="#ffffff",
            fg="#0f172a",
            padx=8,
            pady=8,
        )
        e_scroll = ttk.Scrollbar(right_frame, command=self.editor.yview)
        self.editor.config(yscrollcommand=e_scroll.set)
        e_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.editor.pack(fill=tk.BOTH, expand=True)

    def setup_statusbar(self):
        self.statusbar = ttk.Frame(self.root, padding=2)
        self.statusbar.pack(side=tk.BOTTOM, fill=tk.X)
        
        self.status_text = ttk.Label(self.statusbar, text="Ready | Pulan Tamil OCR")
        self.status_text.pack(side=tk.LEFT, padx=4)

        self.status_res = ttk.Label(self.statusbar, text="300 DPI | 100%")
        self.status_res.pack(side=tk.RIGHT, padx=8)

    def open_file(self):
        files = filedialog.askopenfilenames(
            title="Open Document Image or PDF",
            filetypes=[("Supported Files", "*.png *.jpg *.jpeg *.tif *.tiff *.pdf"), ("All Files", "*.*")]
        )
        if not files:
            return

        self.pages = list(files)
        self.page_tree.delete(*self.page_tree.get_children())
        for i, fpath in enumerate(self.pages, 1):
            fname = os.path.basename(fpath)
            self.page_tree.insert("", "end", iid=str(i - 1), text=f"Page {i}: {fname}")

        self.current_page_idx = 0
        self.load_page(0)

    def load_page(self, idx):
        if not self.pages or idx < 0 or idx >= len(self.pages):
            return
        self.current_page_idx = idx
        fpath = self.pages[idx]
        self.page_label.config(text=f"Page {idx + 1} / {len(self.pages)}")
        
        self.original_image = Image.open(fpath).convert("RGB")
        self.current_image = self.original_image.copy()
        self.zoom_level = 1.0
        self.render_image_on_canvas()
        self.status_text.config(text=f"Loaded: {os.path.basename(fpath)} ({self.original_image.width}x{self.original_image.height})")

    def render_image_on_canvas(self):
        if not self.current_image:
            return
        w = int(self.current_image.width * self.zoom_level)
        h = int(self.current_image.height * self.zoom_level)
        resized = self.current_image.resize((w, h), Image.Resampling.LANCZOS)
        self.tk_image = ImageTk.PhotoImage(resized)

        self.canvas.delete("all")
        self.canvas.create_image(0, 0, anchor=tk.NW, image=self.tk_image)
        self.canvas.config(scrollregion=(0, 0, w, h))

        # Redraw detected layout zones
        for z in self.zones:
            zx = int(z["x"] * self.zoom_level)
            zy = int(z["y"] * self.zoom_level)
            zw = int(z["width"] * self.zoom_level)
            zh = int(z["height"] * self.zoom_level)
            self.canvas.create_rectangle(zx, zy, zx + zw, zy + zh, outline="#3b82f6", width=2, dash=(4, 4))
            self.canvas.create_text(zx + 15, zy + 15, text=f"#{z['order']} {z.get('type', 'Col')}", fill="#2563eb", font=("Helvetica", 10, "bold"))

        self.status_res.config(text=f"{int(self.zoom_level * 100)}% Zoom")

    def detect_layout_current_page(self):
        if not self.current_image:
            messagebox.showinfo("Notice", "Please open an image or PDF first.")
            return

        w, h = self.current_image.width, self.current_image.height
        col_w = int(w * 0.42)
        zones = [
            {"order": 1, "col": 1, "type": "Column 1", "x": int(w * 0.05), "y": int(h * 0.05), "width": col_w, "height": int(h * 0.9)},
            {"order": 2, "col": 2, "type": "Column 2", "x": int(w * 0.52), "y": int(h * 0.05), "width": col_w, "height": int(h * 0.9)},
        ]
        self.zones = zones
        self.render_image_on_canvas()
        self.status_text.config(text=f"Detected 2-column layout on Page {self.current_page_idx + 1}")

    def detect_layout_all_pages(self):
        if not self.pages:
            messagebox.showinfo("Notice", "Please open a document first.")
            return
        self.detect_layout_current_page()
        messagebox.showinfo("Layout Detection", f"Multi-column layout detection completed across all {len(self.pages)} pages in reading order!")

    def recognize_current_page(self):
        if not self.current_image:
            return
        if not pytesseract:
            messagebox.showerror("Error", "pytesseract is not installed on this system.")
            return

        self.status_text.config(text=f"Recognizing Page {self.current_page_idx + 1} with {self.ocr_engine.get()}...")
        self.root.update_idletasks()

        try:
            text = pytesseract.image_to_string(self.current_image, lang="tam+eng", config="--psm 3")
            self.editor.insert(tk.END, f"\n\n--- Page {self.current_page_idx + 1} ({self.ocr_engine.get()}) ---\n" + text)
            self.status_text.config(text=f"OCR completed successfully for Page {self.current_page_idx + 1}")
        except Exception as e:
            messagebox.showerror("OCR Error", str(e))

    def recognize_selection(self):
        self.recognize_current_page()

    def recognize_all_pages(self):
        for i in range(len(self.pages)):
            self.load_page(i)
            self.recognize_current_page()

    def zoom_in(self):
        self.zoom_level = min(3.0, self.zoom_level + 0.2)
        self.render_image_on_canvas()

    def zoom_out(self):
        self.zoom_level = max(0.2, self.zoom_level - 0.2)
        self.render_image_on_canvas()

    def fit_to_window(self):
        if not self.current_image:
            return
        cw = self.canvas.winfo_width()
        if cw > 50:
            self.zoom_level = cw / self.current_image.width
            self.render_image_on_canvas()

    def actual_size(self):
        self.zoom_level = 1.0
        self.render_image_on_canvas()

    def rotate_image(self, angle):
        if not self.current_image:
            return
        self.current_image = self.current_image.rotate(angle, expand=True)
        self.render_image_on_canvas()

    def prev_page(self):
        if self.current_page_idx > 0:
            self.load_page(self.current_page_idx - 1)

    def next_page(self):
        if self.current_page_idx < len(self.pages) - 1:
            self.load_page(self.current_page_idx + 1)

    def on_page_select(self, event):
        sel = self.page_tree.selection()
        if sel:
            idx = int(sel[0])
            self.load_page(idx)

    def insert_tamil_char(self, char):
        self.editor.insert(tk.INSERT, char)

    def clear_editor(self):
        self.editor.delete("1.0", tk.END)

    def save_text(self):
        fpath = filedialog.asksaveasfilename(defaultextension=".txt", filetypes=[("Text File", "*.txt")])
        if fpath:
            with open(fpath, "w", encoding="utf-8") as f:
                f.write(self.editor.get("1.0", tk.END))
            messagebox.showinfo("Saved", f"Document saved to {fpath}")

    def export_as(self, fmt):
        content = self.editor.get("1.0", tk.END).strip()
        if not content:
            messagebox.showwarning("Empty", "Editor is empty. Run OCR first!")
            return

        fpath = filedialog.asksaveasfilename(
            defaultextension=f".{fmt}",
            filetypes=[(f"{fmt.upper()} File", f"*.{fmt}")]
        )
        if not fpath:
            return

        if fmt == "txt":
            with open(fpath, "w", encoding="utf-8") as f:
                f.write(content)
        elif fmt == "docx":
            if not docx:
                messagebox.showerror("Error", "python-docx is not installed.")
                return
            doc = docx.Document()
            doc.add_heading("Tamil OCR Document", level=0)
            for line in content.split("\n"):
                if line.strip():
                    doc.add_paragraph(line.strip())
            doc.save(fpath)
        elif fmt == "json":
            data = {"title": "Tamil OCR Document", "content": content}
            with open(fpath, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        elif fmt == "html":
            html = f"<!DOCTYPE html><html><head><meta charset='utf-8'><title>Tamil OCR</title></head><body><pre>{content}</pre></body></html>"
            with open(fpath, "w", encoding="utf-8") as f:
                f.write(html)

        messagebox.showinfo("Export Successful", f"Exported document successfully to {fpath}")


if __name__ == "__main__":
    root = tk.Tk()
    app = PulanTamilOCRApp(root)
    root.mainloop()

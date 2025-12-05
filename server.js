const express = require('express');
const cors = require('cors');
const db = require('./db'); 
const multer = require('multer'); 
const fs = require('fs'); 
const cloudinary = require('cloudinary').v2; 
const path = require('path'); 

const app = express();
const PORT = process.env.PORT || 5000;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, TEMP_UPLOAD_DIR); 
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage }); 

const TEMP_BASE_DIR = '/tmp';
const TEMP_UPLOAD_DIR = path.join(TEMP_BASE_DIR, 'temp_uploads');

if (!fs.existsSync(TEMP_UPLOAD_DIR)) {
    fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });
}


function getPublicIdFromUrl(url) {
    if (!url) return null;
    const parts = url.split('/');
    const filename = parts.pop();
    const publicId = filename.substring(0, filename.lastIndexOf('.'));
    return publicId;
}


function deleteTempFile(filePath) {
    if (filePath && fs.existsSync(filePath)) {
        fs.unlink(filePath, (err) => {
            if (err) console.error("Gagal menghapus file sementara:", err);
        });
    }
}


// --- Middleware ---
app.use(cors()); 
app.use(express.json()); 


app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        // UPDATE: Pilih fullname
        const result = await db.query('SELECT id, username, fullname FROM admin_users WHERE username = $1 AND password = $2', [username, password]);
        if (result.rows.length === 0) {
            return res.status(401).json({ message: "username atau kata sandi salah" });
        }
        // UPDATE: Kembalikan info user termasuk fullname
        res.json({ message: "Login berhasil", user: result.rows[0] });
    } catch (err) {
        console.error("Error during login:", err);
        res.status(500).json({ message: "Terjadi kesalahan server saat login." });
    }
});


// --- Endpoint API untuk Buku ---

// 1. GET /api/books (Read All)
app.get('/api/books', async (req, res) => {
  try {
    // 1. Ambil semua buku
    const booksResult = await db.query('SELECT *, added_by_admin FROM books ORDER BY id DESC'); 
    const books = booksResult.rows;

    if (books.length === 0) {
      return res.json([]);
    }

    const bookIds = books.map(b => b.id);

    // 2. Ambil semua peminjaman aktif untuk buku-buku tersebut
    // Menggunakan alias untuk mencocokkan struktur data frontend lama (name, phone, date, handledBy)
    const borrowingsResult = await db.query(
      `SELECT id, book_id, borrower_name as name, borrower_phone as phone, borrow_date as date, handled_by_admin as "handledBy" 
       FROM borrowings 
       WHERE book_id = ANY($1::int[]) 
       ORDER BY borrow_date ASC`, 
      [bookIds]
    );

    const borrowings = borrowingsResult.rows;

    // 3. Gabungkan data peminjaman ke dalam data buku
    const booksMap = new Map(books.map(book => [book.id, { ...book, borrowers: [] }]));

    borrowings.forEach(borrowing => {
      if (booksMap.has(borrowing.book_id)) {
        // Hapus book_id dan tambahkan ke array borrowers buku yang sesuai
        const { book_id, ...borrowerData } = borrowing; 
        booksMap.get(book_id).borrowers.push(borrowerData);
      }
    });

    res.json(Array.from(booksMap.values())); 
  } catch (err) {
    console.error("Error fetching books:", err);
    res.status(500).json({ message: "Gagal mengambil data buku dari database." });
  }
});


// 2. POST /api/books (Create)
app.post('/api/books', upload.single('cover_file'), async (req, res) => {
  // HAPUS: 'borrowers_json' dari dekonstruksi
  const { title, author, publisher, year, category, stock, description, status, added_by_admin } = req.body;
  const tempFilePath = req.file ? req.file.path : null; 
  
  const yearInt = year ? parseInt(year) : null;
  const stockInt = stock ? parseInt(stock) : 0;
  
  let coverUrl = null;

  try {
    // 1. Upload ke Cloudinary jika ada file
    if (tempFilePath) {
        const cloudinaryResult = await cloudinary.uploader.upload(tempFilePath, {
            folder: "smart-library-covers",
        });
        coverUrl = cloudinaryResult.secure_url;
    }
    
    // 2. Simpan URL Cloudinary & added_by_admin ke Database (Hapus kolom borrowers)
    const INSERT_QUERY = `
      INSERT INTO books 
      (title, author, publisher, year, category, cover, stock, description, status, added_by_admin)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
      RETURNING *;
    `;
    // UPDATE: Hapus data peminjam dari values
    const values = [
      title, author, publisher, yearInt, category, coverUrl, 
      stockInt, description, status, added_by_admin
    ];
    
    const result = await db.query(INSERT_QUERY, values);
    
    // Gabungkan dengan array borrowers kosong sebelum dikirim ke FE (pertahankan struktur GET)
    res.status(201).json({ ...result.rows[0], borrowers: [] }); 
  } catch (err) {
    console.error("Error creating book:", err);
    res.status(500).json({ message: "Gagal menambahkan buku." });
  } finally {
    // 3. Hapus file sementara lokal
    deleteTempFile(tempFilePath); 
  }
});


// 3. PUT /api/books/:id (Update)
app.put('/api/books/:id', upload.single('cover_file'), async (req, res) => {
  const { id } = req.params;
  const { 
    title, author, publisher, year, category, 
    stock, description, status, existing_cover, added_by_admin 
  } = req.body; 
  // HAPUS: 'borrowers_json' dari dekonstruksi
  
  const yearInt = year ? parseInt(year) : null;
  const stockInt = stock ? parseInt(stock) : 0;
  const tempFilePath = req.file ? req.file.path : null; 

  let newCoverUrl = null;
  let oldCoverUrl = null;
  
  // 1. Dapatkan URL lama dari DB
  const existingBook = await db.query('SELECT cover FROM books WHERE id = $1', [id]);
  if (existingBook.rows.length === 0) {
       return res.status(404).json({ message: `Buku dengan ID ${id} tidak ditemukan.` });
  }
  oldCoverUrl = existingBook.rows[0].cover;
  
  try {
    if (tempFilePath) {
        // Case 1: Ada file baru diupload. Upload file baru
        const cloudinaryResult = await cloudinary.uploader.upload(tempFilePath, {
            folder: "smart-library-covers",
        });
        newCoverUrl = cloudinaryResult.secure_url;
        
        // Hapus cover lama dari Cloudinary jika ada
        if (oldCoverUrl) {
            const publicId = path.basename(oldCoverUrl, path.extname(oldCoverUrl));
            await cloudinary.uploader.destroy(`smart-library-covers/${publicId}`); 
        }

    } else if (existing_cover) {
        // Case 2: Tidak ada file baru, tapi ada URL lama (tidak diubah)
        newCoverUrl = oldCoverUrl; 
    } else {
        // Case 3: Gambar dihapus (atau memang tidak ada)
        newCoverUrl = null;
        // Hapus cover lama dari Cloudinary jika ada
        if (oldCoverUrl) {
            const publicId = path.basename(oldCoverUrl, path.extname(oldCoverUrl));
            await cloudinary.uploader.destroy(`smart-library-covers/${publicId}`);
        }
    }


    // 2. Update Database (Hapus kolom borrowers dari query UPDATE)
    const UPDATE_QUERY = `
      UPDATE books SET
        title = $1, author = $2, publisher = $3, year = $4, category = $5, 
        cover = $6, stock = $7, description = $8, status = $9, added_by_admin = $10
      WHERE id = $11
      RETURNING *;
    `;
    // UPDATE: Hapus data peminjam dari values
    const values = [
      title, author, publisher, yearInt, category, 
      newCoverUrl, stockInt, description, status, added_by_admin, id 
    ];

    const result = await db.query(UPDATE_QUERY, values);
    
    // Ambil data peminjam saat ini untuk dikirim ke FE (mempertahankan struktur GET)
    const borrowingsResult = await db.query(
      `SELECT id, book_id, borrower_name as name, borrower_phone as phone, borrow_date as date, handled_by_admin as "handledBy" 
       FROM borrowings 
       WHERE book_id = $1 ORDER BY borrow_date ASC`, 
      [id]
    );

    res.json({ ...result.rows[0], borrowers: borrowingsResult.rows }); 
  } catch (err) {
    console.error("Error updating book:", err);
    res.status(500).json({ message: "Gagal memperbarui buku." });
  } finally {
    // 3. Hapus file sementara lokal
    deleteTempFile(tempFilePath); 
  }
});

// 4. DELETE /api/books/:id (Delete) - Tidak Berubah selain penanganan FK (ON DELETE CASCADE)
app.delete('/api/books/:id', async (req, res) => {
  const { id } = req.params;

  let coverUrlToDelete = null;
  
  try {
    // 1. Ambil URL cover lama sebelum dihapus
    const existingBook = await db.query('SELECT cover FROM books WHERE id = $1', [id]);
    if (existingBook.rows.length === 0) {
        return res.status(404).json({ message: `Buku dengan ID ${id} tidak ditemukan.` });
    }
    coverUrlToDelete = existingBook.rows[0].cover;

    // CATATAN: Foreign Key ON DELETE CASCADE di tabel borrowings akan menangani penghapusan peminjaman terkait

    // 2. Hapus dari Database
    const DELETE_QUERY = 'DELETE FROM books WHERE id = $1 RETURNING *;';
    const result = await db.query(DELETE_QUERY, [id]);

    // 3. Hapus dari Cloudinary
    if (coverUrlToDelete) {
        const publicId = path.basename(coverUrlToDelete, path.extname(coverUrlToDelete));
        await cloudinary.uploader.destroy(`smart-library-covers/${publicId}`); 
        console.log(`File cover dihapus dari Cloudinary: ${publicId}`);
    }

    res.status(204).send(); 
  } catch (err) {
    console.error("Error deleting book:", err);
    res.status(500).json({ message: "Gagal menghapus buku." });
  }
});


// --- ENDPOINT BARU UNTUK PINJAMAN ---

// 5. POST /api/books/:bookId/borrow (Pinjam Buku)
app.post('/api/books/:bookId/borrow', async (req, res) => {
    const { bookId } = req.params;
    const { name, phone, handledBy } = req.body; // Menerima handledBy dari frontend

    try {
        // 1. Cek stok buku dan LOCK row untuk menghindari race condition
        const bookResult = await db.query('SELECT stock, status, title FROM books WHERE id = $1 FOR UPDATE', [bookId]);
        if (bookResult.rows.length === 0) {
            return res.status(404).json({ message: "Buku tidak ditemukan." });
        }

        const book = bookResult.rows[0];
        if (book.stock <= 0) {
            return res.status(400).json({ message: "Stok habis, tidak bisa dipinjam." });
        }

        // 2. Kurangi stok dan perbarui status buku (dalam satu transaksi)
        await db.query('BEGIN');
        
        const newStock = book.stock - 1;
        // Status baru: "Tersedia" jika stok > 0, "Dipinjam" jika stok = 0.
        const newStatus = (newStock > 0) ? "Tersedia" : "Dipinjam"; 

        const updateBookQuery = `
          UPDATE books SET stock = $1, status = $2 
          WHERE id = $3;
        `;
        await db.query(updateBookQuery, [newStock, newStatus, bookId]);

        // 3. Tambahkan entri ke tabel borrowings
        const INSERT_BORROWING_QUERY = `
          INSERT INTO borrowings 
          (book_id, borrower_name, borrower_phone, handled_by_admin)
          VALUES ($1, $2, $3, $4) 
          RETURNING id, book_id, borrower_name as name, borrower_phone as phone, borrow_date as date, handled_by_admin as "handledBy";
        `;
        const newBorrowing = await db.query(INSERT_BORROWING_QUERY, [bookId, name, phone, handledBy]);

        await db.query('COMMIT');
        
        res.status(201).json({ 
            message: `Buku "${book.title}" berhasil dipinjam.`, 
            borrowing: newBorrowing.rows[0],
            newStock: newStock,
            newStatus: newStatus
        });
    } catch (err) {
        await db.query('ROLLBACK');
        console.error("Error processing borrow:", err);
        res.status(500).json({ message: "Gagal memproses peminjaman buku." });
    }
});

// 6. DELETE /api/books/:bookId/borrowings/:borrowingId (Pengembalian Buku)
app.delete('/api/books/:bookId/borrowings/:borrowingId', async (req, res) => {
    const { bookId, borrowingId } = req.params;

    try {
        // 1. Cek dan hapus peminjaman (dalam satu transaksi)
        await db.query('BEGIN');
        
        const deleteResult = await db.query('DELETE FROM borrowings WHERE id = $1 AND book_id = $2 RETURNING *', [borrowingId, bookId]);
        
        if (deleteResult.rows.length === 0) {
            await db.query('ROLLBACK');
            return res.status(404).json({ message: "Peminjaman tidak ditemukan." });
        }

        // 2. Ambil stok dan perbarui stok buku
        const bookResult = await db.query('SELECT stock, title FROM books WHERE id = $1 FOR UPDATE', [bookId]);
        const currentStock = bookResult.rows[0].stock;
        
        const newStock = currentStock + 1;
        
        // Cek apakah masih ada peminjam lain untuk menentukan status
        const activeBorrowings = await db.query('SELECT COUNT(*) FROM borrowings WHERE book_id = $1', [bookId]);
        const activeBorrowerCount = parseInt(activeBorrowings.rows[0].count, 10);

        const newStatus = (newStock > 0 || activeBorrowerCount > 0) ? "Tersedia" : "Dipinjam";
        
        const updateBookQuery = `
          UPDATE books SET stock = $1, status = $2
          WHERE id = $3;
        `;
        await db.query(updateBookQuery, [newStock, newStatus, bookId]);

        await db.query('COMMIT');
        
        res.status(204).send(); 
    } catch (err) {
        await db.query('ROLLBACK');
        console.error("Error processing return:", err);
        res.status(500).json({ message: "Gagal memproses pengembalian buku." });
    }
});

app.get('/', (req, res) => {
    res.send('Smart Library API sedang berjalan...');
});

const startServer = async () => {
    try {
        await db.initializeDatabase();
        
        app.listen(PORT, () => {
          console.log(`Server berjalan di port ${PORT}`);
        });
    } catch (error) {
        console.error("Gagal memulai server:", error);
        process.exit(1);
    }
}

startServer();
